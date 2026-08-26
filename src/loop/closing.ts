import type { ProjectConfig } from '../config/schema.js';
import { recordClosureBaseline } from '../documents/baseline.js';
import { appendAuditLine } from '../gates/audit.js';
import { enqueue, refusalOf } from '../gates/queue.js';
import type { ScopeChangePreview } from '../gates/schema.js';
import { clearOpenTour, readOpenTour } from '../progress/open-tour.js';
import type { OpenTourBlock, TourJob } from '../progress/open-tour.js';
import { commitExists, headCommit, isAncestorOf, remoteCarries } from '../state/git.js';
import { clearLastFailure } from '../state/last-failure.js';
import { advance } from '../state/machine.js';
import type { StateMarker, TourDisposition } from '../state/marker.js';
import { type ClosingReport, type ReportedDebt, readReportFile } from '../state/report.js';
import { assertDrivenState } from './state-guard.js';
import { appendPending, tourLogPath } from './tour-log.js';

/**
 * Tour closure (SDD §4.6).
 *
 * The procedure the design document never had (D-72): every other state in
 * §3.2 carried a section and this one carried a table cell, which is how the
 * artifacts §4.4 and §4.5 require came to be produced by nothing.
 *
 * The load-bearing step is the second one. The report is a record and records
 * are not evidence (§3.3): a report that is wrong about what it did is the
 * ordinary case, not the exceptional one, and closure is the last moment
 * anything checks. So its claims are checked against `.git` and the
 * disagreement is written into the tour log rather than resolved by believing
 * either side.
 */

/**
 * The PM, as closure needs it. Injected for the same reason the other two
 * sessions are: a session is a live SDK query against an account.
 */
export interface ClosingSession {
  /** Writes the document change a debt calls for, with its version bumped. */
  readonly settleDebt: (debt: ReportedDebt) => Promise<void>;
  /** Writes the tour log under the tour-log directory (§4.6 step 4). */
  readonly writeTourLog: (log: { tourId: string; body: string }) => Promise<void>;
}

export interface DriveClosingInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as resumption left it. Must read `CLOSING`. */
  readonly marker: StateMarker;
  readonly session: ClosingSession;
  readonly now?: () => Date;
}

/** What the report claimed and the repository says, side by side (§4.6 step 2). */
export interface ClaimCheck {
  /** One line per commit the report claims and `.git` does not confirm. */
  readonly commits: readonly string[];
  /** Why the push claim does not hold, or null where it does. */
  readonly push: string | null;
}

export type ClosingResult =
  | {
      readonly kind: 'closed';
      readonly marker: StateMarker;
      readonly claimCheck: ClaimCheck;
      readonly disposition: TourDisposition;
      readonly tourLog: string;
      /** The occasion the commit gate is to be asked about (§4.5, D-76). */
      readonly commitOccasion: {
        readonly kind: 'closure';
        readonly tourId: string;
        readonly state: 'CLOSING';
        readonly disposition: TourDisposition;
      };
    }
  | {
      readonly kind: 'gated';
      readonly marker: StateMarker;
      readonly claimCheck: ClaimCheck;
      readonly gateId: string;
      readonly debt: ReportedDebt;
      readonly tourLog: null;
      readonly commitOccasion: null;
    };

/**
 * Checks the report's commit and push claims against the repository.
 *
 * A commit is confirmed only when it exists AND is reachable from HEAD: an
 * object that exists on nobody's branch was not made by the tour that says it
 * was, and reading "the hash resolves" as "the commit happened" would accept
 * exactly the report a wrong one produces.
 */
function checkClaims(root: string, config: ProjectConfig, report: ClosingReport): ClaimCheck {
  const head = headCommit(root);
  const commits: string[] = [];

  for (const claimed of report.commits) {
    if (!commitExists(root, claimed)) {
      commits.push(
        `${claimed}: the report claims this commit and the repository has no such object.`,
      );
      continue;
    }
    if (head !== null && !isAncestorOf(root, claimed, head)) {
      commits.push(
        `${claimed}: the report claims this commit and it is not reachable from HEAD, so it is on no branch this tour left behind.`,
      );
    }
  }

  let push: string | null = null;
  if (report.pushed) {
    const at = head;
    const carried = at === null ? null : remoteCarries(root, 'origin', config.defaultBranch, at);
    if (carried === null) {
      push =
        'the report claims the work was pushed and there is no remote tracking ref to confirm it against.';
    } else if (!carried) {
      push = `the report claims the work was pushed and origin/${config.defaultBranch} does not carry HEAD.`;
    }
  }

  return { commits, push };
}

/** The unfinished jobs a carried tour leaves for its successor (§4.6 step 5). */
function unfinished(block: OpenTourBlock): readonly TourJob[] {
  return block.jobs.filter((job) => job.status !== 'done');
}

export async function driveClosing(input: DriveClosingInput): Promise<ClosingResult> {
  assertDrivenState(input.marker, 'CLOSING');
  const tourId = input.marker.tourId;
  if (tourId === null) {
    throw new Error('a tour closing has an identifier: it was minted when its record was created.');
  }

  // Read, not derived and not passed in beside the marker (D-92, §4.6 step 5).
  // The state that decided the disposition wrote it here, and this is the one
  // place it is read; a second source travelling alongside the marker would be
  // a second answer, and a resumed cycle would have only one of them.
  const disposition = input.marker.disposition;
  if (disposition === null) {
    throw new Error(
      `${tourId} is closing under no disposition. The marker carries one in CLOSING and the schema refuses a marker without it, so an absent one here is a marker built past the schema rather than read through it (SDD §3.3, §4.6 step 5, D-92).`,
    );
  }

  const now = input.now ?? (() => new Date());
  const rules = { attemptBudget: input.config.attemptBudget };

  // Step 1. The report is read from disk, never taken from a session: §4.4's
  // CLOSING branch has to survive a death, and a report that lives only in a
  // transcript is gone the moment the process is (D-73). Three cases, because
  // closure acts differently on each.
  const file = readReportFile(input.root, tourId);
  if (file.kind === 'aborted') {
    throw new Error(
      `${tourId} left an aborted record rather than a report, so the session did not finish and CLOSING is not the state that should have been reached (SDD §4.6 step 1, D-88). Closure says so rather than closing a tour whose work is unknown. Its tour log would have gone to ${tourLogPath(input.root, input.config, tourId)}.`,
    );
  }

  // A report that never arrived is the third case (D-98). The orchestrator
  // writes it when the session's generator completes (A.4), so a death in that
  // window leaves every acceptance criterion passing and no file at all, which
  // is neither a report nor an aborted record. Closure continues from the
  // block and `.git`, which is what step 2 checks against in any case.
  const report = file.kind === 'report' ? file.report : null;

  // Step 2. Checked, not adopted. A lost report claimed nothing, so there is
  // nothing to check and nothing is invented to check.
  const claimCheck =
    report === null ? { commits: [], push: null } : checkClaims(input.root, input.config, report);

  // Step 3. Settle what can be settled; a debt needing a scope decision is the
  // owner's (D-75), and CLOSING cannot reach IDLE with one open (§3.2).
  const declined: ReportedDebt[] = [];
  for (const debt of report?.debts ?? []) {
    if (debt.settleable) {
      await input.session.settleDebt(debt);
      continue;
    }

    // A refusal the owner has already given settles the debt (D-79). Without
    // this the general rejection rule returns the tour to CLOSING with the
    // same unsettleable debt, which raises the same gate, which is the loop
    // D-50 closed for planning and left open here.
    const refused = refusalOf(input.root, {
      gateClass: 'scope-change',
      what: scopeChangeQuestion(debt),
      tourId,
    });
    if (refused === null) return raiseScopeChange(input, debt, claimCheck, now());

    declined.push(debt);
    appendAuditLine(input.root, {
      ts: now().toISOString(),
      gateId: refused.gateId,
      event: 'declined',
      payload: {
        document: debt.document,
        section: debt.section,
        problem: debt.problem,
        decided_by: refused.decidedBy,
        note: refused.decisionNote,
      },
    });
  }

  const read = readOpenTour(input.root, input.config.docRoot);
  const block = read.kind === 'open' ? read.block : null;

  // Step 4 and 5. The log is the permanent record; the block is not.
  const tourLog = renderTourLog(tourId, report, claimCheck, disposition, block, declined);
  await input.session.writeTourLog({ tourId, body: tourLog });
  if (disposition === 'carried' && block !== null) {
    appendPending(input.root, input.config, tourId, unfinished(block));
  }

  // Step 6. The baseline the commit gate compares against, where git cannot
  // supply one (§3.4, §4.5, D-8, D-30).
  recordClosureBaseline(input.root, input.config);

  // Step 7. The block, the failure record and the counter all go at IDLE.
  clearOpenTour(input.root, input.config.docRoot);
  clearLastFailure(input.root);
  const marker = advance(input.root, input.marker, { type: 'close' }, rules, now()).marker;

  return {
    kind: 'closed',
    marker,
    claimCheck,
    disposition,
    tourLog,
    // Step 8. Closure does not commit: it says which occasion the commit gate
    // is to be asked about, and the gate decides (§4.5, D-76).
    commitOccasion: {
      kind: 'closure',
      tourId,
      state: 'CLOSING',
      disposition,
    },
  };
}

/**
 * The question a scope-change gate asks about one debt.
 *
 * Its single home, because it is the key a later refusal is matched on
 * (D-67's rule, one procedure over): a reworded question fails to match rather
 * than matching wrongly, which is the safe direction, and two copies of the
 * wording would eventually be two questions.
 */
function scopeChangeQuestion(debt: ReportedDebt): string {
  return `Decide the scope question ${debt.document} §${debt.section} raises before the tour closes`;
}

function raiseScopeChange(
  input: DriveClosingInput,
  debt: ReportedDebt,
  claimCheck: ClaimCheck,
  now: Date,
): ClosingResult {
  const preview: ScopeChangePreview = {
    kind: 'scope-change',
    sections: [
      {
        document: debt.document,
        section: debt.section,
        diff: `The tour reported: ${debt.problem}\nSettling it needs a scope decision, which the PM does not take (CHARTER §2.2).`,
      },
    ],
  };

  const entry = enqueue(
    input.root,
    {
      gateClass: 'scope-change',
      tourId: input.marker.tourId,
      jobIndex: input.marker.jobIndex,
      interruptedState: 'CLOSING',
      what: scopeChangeQuestion(debt),
      why: 'FR-2.1 and CHARTER §2.2: the PM settles document debts and does not set scope, and §3.2 forbids reaching IDLE with an open debt (D-75)',
      preview,
    },
    { now },
  );

  return {
    kind: 'gated',
    marker: advance(
      input.root,
      input.marker,
      { type: 'raise-gate', gateClass: 'scope-change', gateId: entry.gateId },
      { attemptBudget: input.config.attemptBudget },
      now,
    ).marker,
    claimCheck,
    gateId: entry.gateId,
    debt,
    tourLog: null,
    commitOccasion: null,
  };
}

/** The tour log's body (§4.6 step 4): what a later reader has instead of the block. */
function renderTourLog(
  tourId: string,
  report: ClosingReport | null,
  claimCheck: ClaimCheck,
  disposition: TourDisposition,
  block: OpenTourBlock | null,
  declined: readonly ReportedDebt[],
): string {
  const disagreements = [
    ...claimCheck.commits,
    ...(claimCheck.push === null ? [] : [claimCheck.push]),
  ];

  return [
    `# ${tourId}`,
    '',
    `- **Disposition:** ${disposition}`,
    `- **Goal:** ${block?.goal ?? 'not recorded'}`,
    `- **Based on:** ${block?.basedOn ?? 'not recorded'}`,
    '',
    ...(report === null ? lostReportSection() : []),
    '## Jobs',
    '',
    ...(report === null
      ? ['Not reported: the report was lost. The block below is what the tour left.']
      : report.jobs.length === 0
        ? ['None reported.']
        : report.jobs.map((job, index) => `${index + 1}. ${job.title}: ${job.verdict}`)),
    '',
    '## Commits claimed',
    '',
    report === null
      ? 'Nothing was claimed, because there was no report to claim it.'
      : report.commits.length === 0
        ? 'None.'
        : report.commits.join(', '),
    '',
    '## Where the report and the repository disagreed',
    '',
    // Kept in the log because closure is the last moment anything checks, and
    // a disagreement resolved silently would be a disagreement nobody could
    // find afterwards (§4.6 step 2).
    ...(disagreements.length === 0 ? ['Nowhere.'] : disagreements.map((line) => `- ${line}`)),
    '',
    '## Document debts the owner declined',
    '',
    // Recorded because the refusal settled the debt rather than the tour
    // (D-79): a reader who finds the change missing from the documents has to
    // be able to see that it was declined rather than forgotten.
    ...(declined.length === 0
      ? ['None.']
      : declined.map(
          (debt) => `- ${debt.document} §${debt.section}: ${debt.problem} (declined by the owner)`,
        )),
    '',
    '## What remains open',
    '',
    ...(block === null
      ? ['The open-tour block could not be read at closure.']
      : unfinished(block).length === 0
        ? ['Nothing.']
        : unfinished(block).map((job) => `- ${job.title}`)),
    '',
    '## Notes',
    '',
    report === null ? 'None: the report was lost.' : report.notes === '' ? 'None.' : report.notes,
    '',
  ].join('\n');
}

/**
 * What the log says where the report never arrived (§4.6 step 1, D-98).
 *
 * The debts are named unrecoverable rather than reported as none. A debt
 * nobody wrote down is the failure this whole procedure exists to prevent, and
 * pretending there were none would be the same failure with better manners.
 */
function lostReportSection(): string[] {
  return [
    '## The report was lost',
    '',
    'The session ended and the report was not written: a death between the',
    'generator completing and the write leaves every acceptance criterion',
    'passing and no file at all (SDD §4.6 step 1, D-98). Its contents are not',
    'reconstructed here.',
    '',
    '**The document debts it would have carried are unrecoverable.** They are',
    'named as unrecoverable rather than assumed absent: nothing here observed',
    'that there were none, only that nobody wrote them down.',
    '',
  ];
}
