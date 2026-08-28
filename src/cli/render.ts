import type { HistoryLog } from '../api/history.js';
import type { DetachResult } from '../api/project.js';
import type { ProjectStatus } from '../api/status.js';
import type { UsageReport } from '../api/usage.js';
import type { ProjectConfig } from '../config/schema.js';
import type { GateEntry, GatePreview } from '../gates/schema.js';
import type { CeilingVerdict } from '../loop/ceiling.js';
import type { RunOutcome } from '../loop/run.js';
import type { InboxLine } from '../state/inbox.js';
import type { LastFailure } from '../state/last-failure.js';

/**
 * What the owner reads (SDD §5.2, FR-3.4, D-51).
 *
 * Every function here takes what an operation returned and produces lines. It
 * calls no operation and touches no file: rendering is the surface's whole
 * job, and a renderer that could also fetch would be a surface with logic of
 * its own (FR-5.1).
 *
 * The language is the owner's rather than the implementation's. A gate states
 * what is about to happen, what follows from approving and from rejecting, and
 * what the PM recommends; the preview carries the evidence and the text
 * carries the decision. Nothing the PM could settle from the canonical
 * documents appears at all, because a surface is where an avoidable question
 * is cheapest to add and most expensive to live with.
 */

/** These imports are types only: nothing here reaches past the API (FR-5.1). */

function indent(lines: readonly string[]): string[] {
  return lines.map((line) => `  ${line}`);
}

function previewLines(preview: GatePreview): string[] {
  switch (preview.kind) {
    case 'push':
      return [
        `${preview.commits.length} commit(s) would go to ${preview.remote}/${preview.branch}:`,
        ...indent(preview.commits.map((commit) => `${commit.hash} ${commit.subject}`)),
      ];
    case 'deployment':
      return [
        `Environment: ${preview.environment}`,
        `Services affected: ${preview.changedServices.join(', ') || 'none'}`,
        preview.pendingMigrations.length === 0
          ? 'Pending migrations: none'
          : `Pending migrations: ${preview.pendingMigrations.join(', ')}`,
      ];
    case 'scope-change':
      return preview.sections.flatMap((section) => [
        `${section.document} ${section.section}:`,
        ...indent(section.diff.split('\n')),
      ]);
    case 'destructive':
      return [
        `Command: ${preview.command}`,
        `Would affect: ${preview.affects.join(', ') || 'nothing this could name'}`,
      ];
    case 'secrets':
      return [
        `Secret: ${preview.secret} (the reference, never the value)`,
        `Asked by: the ${preview.role} role${preview.job === null ? '' : `, on ${preview.job}`}`,
        `The call: ${preview.call}`,
      ];
    case 'tour-budget':
      return [
        `Attempts spent: ${preview.attemptCount}`,
        ...(preview.failure === null
          ? [
              preview.attemptCount === 0
                ? 'No attempt was made, so there is no failure to show: nothing could be run at all.'
                : 'The failure record did not survive the process that made it, so there is nothing to show.',
            ]
          : failureLines(preview.failure)),
      ];
    case 'dirty-tree':
      return [
        'Uncommitted changes in the working tree:',
        ...indent(preview.changes.map((change) => `${change.changeType} ${change.path}`)),
      ];
  }
}

/**
 * The two shapes one failure record comes in (§3.0, D-59).
 *
 * A planning failure has no command and no exit code, so the record travels in
 * its own shape rather than flattened to a string, and rendering it is the
 * surface's job: the preview carries the record and this decides how it reads.
 */
function failureLines(failure: LastFailure): string[] {
  return failure.kind === 'verification'
    ? [
        `The last failure, on attempt ${failure.attempt}: \`${failure.command}\` exited ${failure.exitCode}.`,
        ...indent(
          failure.output.trim() === ''
            ? ['(it printed nothing)']
            : failure.output.trim().split('\n'),
        ),
      ]
    : [
        `The last failure, on attempt ${failure.attempt}: the plan did not parse (${failure.field}: ${failure.problem}).`,
      ];
}

/**
 * What approving and rejecting lead to, by gate class (SDD §3.2, FR-3.4).
 *
 * Read off the state machine rather than stored on the entry. The consequences
 * of a decision are a property of the class and the state it interrupted, both
 * of which the entry carries, so writing them into every entry would be a
 * second copy of §3.2 that nobody bumps when the table changes.
 */
function consequences(entry: GateEntry): string[] {
  const resume = `work resumes in ${entry.interruptedState}, and this approval authorizes exactly this one action and is spent by it`;

  switch (entry.gateClass) {
    case 'tour-budget':
      return [
        `If you approve: the tour gets a fresh attempt budget and ${resume}.`,
        'If you reject: the tour is abandoned. Unfinished work is left as one WIP commit on a branch, the tour log records what was and was not done, and the tour closes.',
      ];
    case 'scope-change':
      return [
        `If you approve: the proposed document change is made and ${resume}.`,
        'If you reject: the change is not made, and the refusal is recorded as a new job rather than being dropped.',
      ];
    case 'dirty-tree':
      return [
        'If you approve: the tour opens over the tree as it stands, uncommitted changes included.',
        'If you reject: nothing is touched and the run exits, leaving your working tree exactly as it is.',
      ];
    default:
      return [
        `If you approve: the action above is performed once and ${resume}.`,
        'If you reject: the action is not performed, and the refusal is recorded as a new job rather than being dropped.',
      ];
  }
}

/**
 * One gate, as the owner decides on it (D-51, FR-3.4).
 *
 * **The recommendation is read, never derived (D-114, D-116).** FR-3.4 says a
 * gate states what the PM recommends, and the entry now carries one. Where it
 * carries none, this says so: most gates are raised by the hook mid-session
 * with no role asked, and deriving advice from the gate's own class would be a
 * restatement of the rule dressed as a view. An owner told "nothing is
 * recorded" knows to decide for themselves; an owner told a rule back knows
 * nothing and may think they were advised.
 */
export function renderGate(entry: GateEntry): string[] {
  const waiting =
    entry.status === 'pending'
      ? entry.parkedAt === null
        ? 'Waiting for you.'
        : `Waiting for you. The tour parked at ${entry.parkedAt}: that released the orchestrator and decided nothing, so this is still yours to answer.`
      : `Already ${entry.status} by ${entry.decidedBy ?? 'the owner'} at ${entry.decidedAt ?? 'an unrecorded moment'}${entry.decisionNote === null ? '' : `, noting: ${entry.decisionNote}`}.`;

  return [
    `Gate ${entry.gateId} (${entry.gateClass})`,
    '',
    `What is about to happen: ${entry.what}`,
    `Why you are being asked: ${entry.why}`,
    entry.tourId === null
      ? 'Raised before any tour was planned.'
      : `Raised in ${entry.tourId}${entry.jobIndex === null ? '' : `, at job ${entry.jobIndex}`}, at ${entry.requestedAt}.`,
    '',
    'The evidence:',
    ...indent(previewLines(entry.preview)),
    '',
    ...consequences(entry),
    '',
    entry.recommendation === null
      ? 'What the PM recommends: nothing is recorded. No role was asked, which is the ordinary case for a gate raised mid-session, so this is yours to weigh rather than advice withheld.'
      : `What the PM recommends: ${entry.recommendation}`,
    '',
    waiting,
    entry.status === 'pending'
      ? `Answer with: wardroom approve ${entry.gateId}  |  wardroom reject ${entry.gateId}`
      : '',
  ].filter((line, index, all) => !(line === '' && all[index - 1] === ''));
}

/** The gate list, one line each, newest information first (FR-3.3). */
export function renderGates(entries: readonly GateEntry[]): string[] {
  if (entries.length === 0) return ['No gate is waiting for you.'];
  return [
    `${entries.length} gate(s) waiting for you:`,
    ...entries.map(
      (entry) =>
        `  ${entry.gateId}  ${entry.gateClass}${entry.parkedAt === null ? '' : ' (parked)'}  ${entry.what}`,
    ),
    '',
    'Read one with: wardroom gate <id>',
  ];
}

function budgetLines(budget: CeilingVerdict): string[] {
  if (budget.kind === 'inactive') return [`Budget: not measured. ${budget.reason}`];
  const spent = `$${budget.spentUsd.toFixed(2)} of $${budget.ceilingUsd.toFixed(2)} spent`;
  return budget.kind === 'reached'
    ? [
        `Budget: ${spent}. The largest job so far cost $${budget.largestJobUsd.toFixed(2)}, so the next job cannot be expected to fit and this tour closes at its next job boundary.`,
      ]
    : [`Budget: ${spent}, with the largest job so far at $${budget.largestJobUsd.toFixed(2)}.`];
}

/** Where the project stands (FR-1.4, FR-3.3). */
export function renderStatus(status: ProjectStatus): string[] {
  const lines: string[] = [`${status.config.name} at ${status.root}`];

  if (status.marker.kind === 'absent') {
    lines.push('State: never run. This project has no state marker yet.');
  } else if (status.marker.kind === 'unreadable') {
    lines.push(
      `State: unknown. The state marker cannot be read (${status.marker.reason}). That is not the same as no tour being open, and nothing here guesses which it is.`,
    );
  } else {
    lines.push(`State: ${status.marker.marker.state}`);
  }

  if (status.openTour.kind === 'open') {
    const block = status.openTour.block;
    lines.push(`Open tour: ${block.tourId}, ${block.goal}`);
    lines.push(
      `  ${block.jobs.filter((job) => job.status === 'done').length} of ${block.jobs.length} jobs done`,
    );
  } else if (status.openTour.kind === 'none') {
    lines.push('Open tour: none.');
  } else {
    lines.push(
      `Open tour: the block in PROGRESS does not parse (${status.openTour.field}: ${status.openTour.problem}).`,
    );
  }

  if (status.currentJob !== null) {
    const job = status.currentJob.job;
    lines.push(
      job === null
        ? `Current job: ${status.currentJob.index}, which the open-tour block has no row for. The two records disagree.`
        : `Current job: ${status.currentJob.index}, ${job.title} (${job.status})`,
    );
  }

  lines.push(
    status.gates.length === 0
      ? 'Gates: none waiting.'
      : `Gates: ${status.gates.length} waiting for you. Read them with: wardroom gates`,
  );
  lines.push(...budgetLines(status.budget));
  return lines;
}

/** What a run did, in the owner's terms rather than the state machine's. */
export function renderRun(outcome: RunOutcome): string[] {
  const visited = `States visited: ${outcome.visited.join(' -> ') || 'none'}`;
  const lines: string[] = [];

  switch (outcome.kind) {
    case 'idle':
      lines.push(
        outcome.disposition === null
          ? 'The project is at a closed boundary and no tour was open to run.'
          : `The tour closed (${outcome.disposition}). One invocation drives one cycle, so the next tour is planned by the next run.`,
      );
      if (outcome.disposition !== null && !outcome.closureCommitRequested) {
        // The one commit of a tour that carries its documents, and it was not
        // made. Said plainly rather than left to be noticed: the cleared block
        // and the tour log are sitting in the working tree.
        lines.push(
          outcome.reason ??
            'Its closure commit was not made, so the documents, the tour log and the cleared block are uncommitted in the working tree.',
        );
      }
      break;
    case 'gated':
      lines.push(
        `Stopped at a gate: ${outcome.reason ?? 'a decision is waiting for you'}. Read it with: wardroom gate ${outcome.gateId ?? ''}`,
      );
      break;
    case 'parked':
      lines.push(
        `The tour is parked: ${outcome.reason ?? 'a gate went unanswered for its waiting period'}. The gate is still pending and still yours to answer; parking released the orchestrator and decided nothing.`,
      );
      break;
    case 'detached':
      lines.push(`The run stopped where you asked it to: ${outcome.reason ?? 'at a job boundary'}`);
      break;
    case 'stopped':
      lines.push(`The run stopped: ${outcome.reason ?? 'no reason was recorded'}`);
      if (outcome.wipRequested) {
        lines.push('Unfinished work was offered as a single WIP commit on a branch.');
      }
      break;
    case 'exited':
      lines.push(`The run exited: ${outcome.reason ?? 'no reason was recorded'}`);
      break;
  }

  lines.push(visited);
  return lines;
}

/** The attributed breakdown NFR-4 asks for, rather than a bare total. */
export function renderUsage(report: UsageReport): string[] {
  const lines: string[] = [
    report.tourId === null
      ? 'Usage for the sessions that precede any tour record:'
      : `Usage for ${report.tourId}:`,
  ];

  if (report.summary.kind === 'inactive') {
    lines.push(`Cost: not measured. ${report.summary.reason}`);
  } else {
    lines.push(
      `Cost: $${report.summary.spentUsd.toFixed(2)} over ${report.summary.jobsMeasured} measured job(s), largest single job $${report.summary.largestJobUsd.toFixed(2)}.`,
    );
  }
  lines.push(
    `Tokens: ${report.summary.tokens.input} in, ${report.summary.tokens.output} out.`,
    ...budgetLines(report.budget),
  );

  const axis = (title: string, buckets: UsageReport['byRole']): string[] =>
    buckets.length === 0
      ? []
      : [
          `${title}:`,
          ...buckets.map(
            (bucket) =>
              `  ${bucket.key}: ${bucket.inputTokens} in, ${bucket.outputTokens} out, ${bucket.usd === null ? 'cost not measured' : `$${bucket.usd.toFixed(2)}`}`,
          ),
        ];

  lines.push(
    ...axis('By role', report.byRole),
    ...axis('By state', report.byState),
    ...axis('By job', report.byJob),
  );
  return lines;
}

/** The tour logs, the gate audit trail and the inbox (FR-3.2, D-108). */
export function renderLog(log: HistoryLog): string[] {
  const lines: string[] = [];

  lines.push(
    log.tours.length === 0
      ? 'Tour logs: none. No tour has closed in this project yet.'
      : `Tour logs (${log.tours.length}):`,
  );
  lines.push(...log.tours.map((tour) => `  ${tour.tourId}  ${tour.path}`));

  lines.push(
    '',
    log.audit.length === 0 ? 'Gate audit trail: empty.' : `Gate audit trail (${log.audit.length}):`,
  );
  lines.push(...log.audit.map((line) => `  ${line.ts}  ${line.gateId}  ${line.event}`));

  lines.push('', ...renderInbox(log.inbox));
  return lines;
}

function renderInbox(inbox: readonly InboxLine[]): string[] {
  if (inbox.length === 0) return ['What you told the roles: nothing yet.'];
  return [
    `What you told the roles (${inbox.length}):`,
    ...inbox.map(
      (line) =>
        `  ${line.writtenAt}  ${line.deliveredAt === null ? 'not yet delivered' : `delivered ${line.deliveredAt}`}  ${line.text}`,
    ),
  ];
}

/** The project contract, with the green definition it exists to show (FR-1.5). */
export function renderConfig(config: ProjectConfig): string[] {
  return [
    `${config.name} (${config.level})`,
    `Documents: ${config.docRoot}`,
    `Default branch: ${config.defaultBranch}`,
    `Stack: ${config.stack.language}, ${config.stack.runtime}, ${config.stack.packageManager}`,
    'Green means all of:',
    ...indent(config.verify),
    `Auth: ${config.authMode}`,
    `A gate parks the tour after: ${config.gateWait.value}${config.gateWait.unit}`,
    `Attempts before the tour budget gate: ${config.attemptBudget}`,
    `Usage ceiling: $${config.usageBudget.usd.toFixed(2)}`,
    `Runtime records tracked: ${config.trackRuntime ? 'yes' : 'no'}`,
  ];
}

/** What a detach asked for, or why it asked for nothing (D-106). */
export function renderDetach(result: DetachResult): string[] {
  return result.kind === 'requested'
    ? [
        `The run was asked to stop at its next job boundary (it is in ${result.state}). It will finish the job it is on and commit before it stops; nothing is killed mid job.`,
      ]
    : [`Nothing was asked to stop: ${result.reason}`];
}

/** One injected note, confirmed back so the owner sees what was recorded. */
export function renderSaid(line: InboxLine): string[] {
  return [
    `Recorded at ${line.writtenAt}: ${line.text}`,
    'The next session of either role opens with it. It is context and not a decision: it releases no gate.',
  ];
}

/** A decision, confirmed back (FR-3.2). */
export function renderDecision(entry: GateEntry): string[] {
  return [
    `Gate ${entry.gateId} (${entry.gateClass}) is ${entry.status}${entry.decisionNote === null ? '' : `, noting: ${entry.decisionNote}`}.`,
    `Recorded at ${entry.decidedAt ?? 'an unrecorded moment'} as ${entry.decidedBy ?? 'the owner'}.`,
  ];
}
