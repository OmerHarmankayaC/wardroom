import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { ensureRunDir, wardroomPaths } from '../config/paths.js';
import type { GateEntry } from '../gates/schema.js';
import { readEntry } from '../gates/store.js';
import { type OpenTourRead, readOpenTour } from '../progress/open-tour.js';
import {
  type CrossCheck,
  type HeadCommitCheck,
  checkHeadCommit,
  crossCheckOpenTour,
  firstUnfinishedRow,
  isCrossCheckConflict,
} from './cross-check.js';
import { headCommit, isWorkingTreeDirty } from './git.js';
import { type LastFailure, failedRoute, readLastFailure } from './last-failure.js';
import {
  GATE_BEARING_STATES,
  type StateMarker,
  type TourState,
  readMarker,
  writeMarker,
} from './marker.js';

/**
 * Resume after process death (SDD §4.4).
 *
 * The next action is reconstructed from repository files alone (FR-1.2): no
 * orchestrator memory and no agent session is consulted. Process death is not
 * a state, so there is nothing to look up, only evidence to read.
 *
 * Two records are read and neither corrects the other. The marker names the
 * tour and the job; the open-tour block names them too; agreement lets
 * resumption proceed and disagreement stops it, because no rule can pick a
 * winner between two records (§4.4, D-96, D-100). What is evidence sits one
 * level down: `.git` for a commit, which step 2 uses, and a job's acceptance
 * criterion for the job, which the `EXECUTING` drive uses.
 *
 * The block is also what closes T-5's sharpest edge. An unreadable marker on a
 * clean tree left git unable to tell a tour open at a job boundary from no
 * tour at all, and the block tells them apart by existing.
 */

export type NextAction =
  /** No open tour: the repository is at a closed boundary. */
  | 'PLAN_TOUR'
  /** Partial planning output is discarded; planning is cheap, half-written scope is not. */
  | 'REPLAN'
  /** Re-enter the job list; any uncommitted diff goes to the Implementer as context. */
  | 'RESUME_EXECUTION'
  /** A partial suite result is never trusted. */
  | 'RERUN_VERIFICATION'
  /** Re-read the document debts; settled ones show as version bumps. */
  | 'RESUME_CLOSING'
  /** The gate entry survives; it is shown again, never auto-approved. */
  | 'REPRESENT_GATE'
  /** The owner decided while the process was down; their answer is applied (D-38). */
  | 'APPLY_GATE_DECISION'
  /** A failed verification within its attempt budget (FR-1.3). */
  | 'RETRY_EXECUTION'
  /** The attempt budget is spent (FR-1.3). */
  | 'RAISE_TOUR_BUDGET_GATE'
  /**
   * Two records disagree, or one of them cannot be read, and nothing here
   * picks a winner (D-96, D-100). `run` reports both readings and exits
   * without writing.
   */
  | 'STOP_UNRESOLVED';

export interface ResumeResult {
  /** The reconstructed state, or null when it could not be established. */
  readonly state: TourState | null;
  readonly nextAction: NextAction;
  /** The corrected marker written before returning, or null if none could be. */
  readonly marker: StateMarker | null;
  readonly headCommit: string | null;
  /** The marker named a commit that is not HEAD; the repository won. */
  readonly headCommitStale: boolean;
  readonly workingTreeDirty: boolean;
  /** Where an unreadable marker was preserved for inspection. */
  readonly discardedMarker: string | null;
  /** What happened, stated rather than implied. */
  readonly events: readonly string[];
  /**
   * The gate a `GATED` or `PARKED` state hangs on, decided or not; null for
   * every other state, and null when the marker claims a gate the queue does
   * not have.
   */
  readonly gate: GateEntry | null;
  /** The two-pair comparison against the open-tour block (§4.4, D-96, D-100). */
  readonly progressCrossCheck: CrossCheck;
  /** What `head_commit` was against `HEAD` (§4.4 step 2, D-100). */
  readonly headCommitCheck: HeadCommitCheck;
  /**
   * Both readings, where something stopped resumption. Empty otherwise.
   *
   * Carried as lines rather than left to the caller to compose, because the
   * whole point of stopping is that the owner sees what the two records said.
   */
  readonly unresolved: readonly string[];
}

/** Moves an unreadable marker aside so it survives its replacement. */
function preserve(root: string, now: Date): string {
  const { runDir, stateFile } = wardroomPaths(root);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const preserved = join(runDir, `state.json.unreadable-${stamp}`);
  renameSync(stateFile, preserved);
  return preserved;
}

/**
 * The gate a gated or parked state is waiting on, or null.
 *
 * Read from the marker, which names it (§3.3, D-62). The directory scan this
 * replaces could not supply it and was wrong in two ways at once: entries are
 * never archived (D-29) so the directory accumulates, and a decided entry may
 * still carry an unconsumed authorization (D-61), so "the pending one" is not
 * unique and "the newest one" is not necessarily the one this tour waits on.
 *
 * Null where the marker names a gate the queue does not hold. That is not the
 * same answer as a state that waits on nothing, and the caller is told which
 * it got.
 */
function gateFor(root: string, marker: StateMarker): GateEntry | null {
  if (!GATE_BEARING_STATES.includes(marker.state) || marker.gateId === null) return null;
  return readEntry(root, marker.gateId);
}

/** SDD §4.4 step 4: what each state resumes as. */
function actionFor(
  state: TourState,
  marker: StateMarker,
  attemptBudget: number,
  gate: GateEntry | null,
  failure: LastFailure | null,
): NextAction {
  switch (state) {
    case 'IDLE':
      return 'PLAN_TOUR';
    case 'PLANNING':
      return 'REPLAN';
    case 'EXECUTING':
      return 'RESUME_EXECUTION';
    case 'VERIFYING':
      return 'RERUN_VERIFICATION';
    case 'CLOSING':
      return 'RESUME_CLOSING';
    case 'GATED':
    case 'PARKED':
      // An entry decided while the process was down is applied, not shown
      // again (D-38). Applying the owner's recorded decision is not auto
      // approval, and a gate is never auto-approved on resume whatever its
      // age; re-presenting a decided gate asks the owner the same question
      // twice.
      return gate !== null && gate.status !== 'pending' ? 'APPLY_GATE_DECISION' : 'REPRESENT_GATE';
    case 'FAILED':
      // The record decides before the counter does (§4.4 step 4). Asked here
      // through the same function the drive asks, because this decision had
      // two homes and they had already disagreed about the absent record.
      switch (failedRoute(marker.attemptCount, attemptBudget, failure)) {
        case 'retry':
          return 'RETRY_EXECUTION';
        case 'gate':
          return 'RAISE_TOUR_BUDGET_GATE';
        case 'reverify':
          return 'RERUN_VERIFICATION';
      }
  }
}

/** The lines a stopped resumption owes the owner: both readings, neither preferred. */
function crossCheckLines(check: CrossCheck): string[] {
  if (check.kind === 'conflict') {
    return check.disagreements.map(
      (pair) =>
        `${pair.pair}: the marker says ${pair.marker} and the open-tour block says ${pair.block}. ${pair.rule}. Both are records and neither is evidence, so nothing here picks a winner (SDD §4.4, D-96, D-104).`,
    );
  }
  if (check.kind === 'unreadable-block') {
    return [
      `the marker names a tour and the open-tour block does not parse (${check.field}: ${check.problem}), so the two cannot be compared and neither can be trusted (SDD §4.4, SRS §3.5).`,
    ];
  }
  return [];
}

/** What a permitted reading is worth saying out loud, and nothing more. */
function crossCheckEvent(check: CrossCheck): string | null {
  switch (check.kind) {
    case 'aligned':
      return 'The open-tour cross-check found the two records aligned on both pairs (SDD §4.4, D-96, D-104).';
    case 'lagging':
      return `The open-tour cross-check found the block one row ahead of the marker (job_index ${check.markerJobIndex}, first row not done ${check.blockRow}): the job was committed and the marker not yet advanced, which is the lag §4.2's write order creates on purpose. Resumption proceeds by step 4's evidence rather than by either record (D-104).`;
    case 'adopting':
      return `The block names ${check.blockTour} and the marker names no tour, under a PLANNING marker: a finished plan whose block was written before the marker, which is adopted (SDD §4.4 step 4, D-49).`;
    case 'block-cleared':
      return `The marker names ${check.markerTour} and the block is cleared, under a CLOSING marker: the block is cleared before the closure commit, so this is the window between them (§4.6 step 6).`;
    default:
      return null;
  }
}

/** The line an unreachable `head_commit` owes the owner (§4.4 step 2, D-100). */
function headCommitLines(check: HeadCommitCheck): string[] {
  if (check.kind !== 'unreachable') return [];
  return [
    `head_commit: the marker names ${check.markerCommit} and ${check.reason}. That is not work completed after the last marker write, so the repository does not simply win here: reconstructing from git would adopt a history the marker says was different (SDD §4.4 step 2, D-100).`,
  ];
}

/** A result that establishes no state and writes nothing. */
function unresolved(partial: Omit<ResumeResult, 'state' | 'nextAction' | 'marker'>): ResumeResult {
  return { ...partial, state: null, nextAction: 'STOP_UNRESOLVED', marker: null };
}

/**
 * Reconstructs the next action for a project root and writes the corrected
 * marker before returning, so a second death lands on the corrected state
 * instead of repeating this reconstruction (step 5).
 */
export function resume(root: string, now: Date = new Date()): ResumeResult {
  const config = loadConfig(root);
  const head = headCommit(root);
  const dirty = isWorkingTreeDirty(root);
  const events: string[] = [];
  const block = readOpenTour(root, config.docRoot);

  const read = readMarker(root);

  if (read.kind === 'unreadable') {
    return fromRepositoryAlone(root, { read, block, head, dirty, events, now });
  }

  if (read.kind === 'absent') {
    events.push('No state marker: this repository has never been run by Wardroom.');
    return finish(root, {
      state: 'IDLE',
      nextAction: 'PLAN_TOUR',
      marker: {
        state: 'IDLE',
        tourId: null,
        jobIndex: null,
        interruptedState: null,
        attemptCount: 0,
        gateId: null,
        disposition: null,
        headCommit: head,
        updatedAt: now.toISOString(),
      },
      headCommit: head,
      headCommitStale: false,
      workingTreeDirty: dirty,
      discardedMarker: null,
      events,
      gate: null,
      progressCrossCheck: { kind: 'no-tour' },
      headCommitCheck: { kind: 'current' },
      unresolved: [],
    });
  }

  const marker = read.marker;

  // Step 2, in the two halves D-100 separates. `head_commit` against `HEAD` is
  // a record measured against evidence, and the cross-check is two records
  // measured against each other; only the first has a winner.
  const headCommitCheck = checkHeadCommit(root, marker.headCommit, head);
  const progressCrossCheck = crossCheckOpenTour(marker, block);
  const stopping = [...headCommitLines(headCommitCheck), ...crossCheckLines(progressCrossCheck)];
  // Read through the one predicate, so no caller decides for itself which
  // readings stop a run (D-104's table has four that do not).
  const stopped =
    headCommitCheck.kind === 'unreachable' || isCrossCheckConflict(progressCrossCheck);

  if (stopped) {
    // A reading that stops the run always says which reading it was. Without
    // this, a conflict kind added without its rendering would stop the run
    // with the general sentence and nothing to look at, which is the whole of
    // what a stop is for.
    const readings =
      stopping.length > 0
        ? stopping
        : [
            `the cross-check answered ${progressCrossCheck.kind} and head_commit answered ${headCommitCheck.kind}, one of which stops resumption and neither of which was rendered. That is a defect in this module rather than in the repository.`,
          ];
    events.push(
      'Resumption stopped without writing: the records it reconstructs from cannot be reconciled, and no rule picks a winner between them (SDD §4.4, D-96, D-100, D-104).',
      ...readings,
    );
    return unresolved({
      headCommit: head,
      headCommitStale: headCommitCheck.kind !== 'current',
      workingTreeDirty: dirty,
      discardedMarker: null,
      events,
      gate: null,
      progressCrossCheck,
      headCommitCheck,
      unresolved: readings,
    });
  }

  if (headCommitCheck.kind === 'behind') {
    events.push(
      [
        `The marker names ${headCommitCheck.markerCommit} and HEAD is ${headCommitCheck.head},`,
        'which HEAD can reach; the repository wins, so work completed after the last marker',
        'write is not lost (step 2, D-100).',
      ].join(' '),
    );
  }
  const crossCheckSaid = crossCheckEvent(progressCrossCheck);
  if (crossCheckSaid !== null) events.push(crossCheckSaid);
  if (block.kind === 'malformed' && !isCrossCheckConflict(progressCrossCheck)) {
    // The marker names no tour, so there was nothing to compare the block
    // against and it did not stop anything. Said out loud rather than passed
    // over: an unreadable block is evidence of a defect somewhere, and
    // planning is about to write over it.
    events.push(
      `The open-tour block does not parse (${block.field}: ${block.problem}). The marker names no tour, so there was nothing to compare it against and resumption was not stopped by it.`,
    );
  }
  if (dirty) {
    events.push(
      'The working tree carries uncommitted work. It is handed on as context and never ' +
        'discarded or stashed (SDD §4.4 step 3).',
    );
  }

  const gate = gateFor(root, marker);
  if (GATE_BEARING_STATES.includes(marker.state) && gate === null) {
    events.push(
      [
        `The marker reads ${marker.state} and names gate ${marker.gateId ?? 'nothing'}, which the`,
        'queue does not hold, so there is nothing to re-present. The entry is the durable',
        'record of a pending decision (TD-3) and it outlives the process by design, so its',
        'absence is evidence of a defect somewhere else rather than of a tour that was never',
        'gated.',
      ].join(' '),
    );
  }
  if (gate !== null && gate.status !== 'pending') {
    events.push(
      `Gate ${gate.gateId} was ${gate.status} by ${gate.decidedBy ?? 'the owner'} while the process was down; that decision is applied rather than asked again (D-38).`,
    );
  }

  return finish(root, {
    state: marker.state,
    nextAction: actionFor(marker.state, marker, config.attemptBudget, gate, readLastFailure(root)),
    marker: { ...marker, headCommit: head, updatedAt: now.toISOString() },
    headCommit: head,
    headCommitStale: headCommitCheck.kind !== 'current',
    workingTreeDirty: dirty,
    discardedMarker: null,
    events,
    gate,
    progressCrossCheck,
    headCommitCheck,
    unresolved: [],
  });
}

interface RepositoryOnlyInput {
  readonly read: Extract<ReturnType<typeof readMarker>, { kind: 'unreadable' }>;
  readonly block: OpenTourRead;
  readonly head: string | null;
  readonly dirty: boolean;
  readonly events: string[];
  readonly now: Date;
}

/**
 * Step 1's second branch: the marker was present and unreadable, so the state
 * is reconstructed from the repository alone.
 *
 * The block is what makes this decidable, which is B-9's whole point (D-96).
 * A block with rows is a tour that was opened; the section stating that no
 * tour is open is no tour; and a block nobody can parse is neither, so
 * resumption stops rather than guessing.
 *
 * The marker is moved aside only where a replacement is about to be written,
 * which is what §4.4 step 1 says ("preserved beside its replacement"). Moving
 * it aside and then writing nothing would leave the next run reading an absent
 * marker, and absent means a repository Wardroom has never run: the open tour
 * would be abandoned silently, which is the one outcome this procedure exists
 * to prevent.
 */
function fromRepositoryAlone(root: string, input: RepositoryOnlyInput): ResumeResult {
  const { block, head, dirty, events, now } = input;
  events.push(
    [
      `The state marker was present but unreadable (${input.read.reason}); it is not treated as`,
      'absent, because an absent marker means a repository that was never run and this one',
      'plainly was (D-20).',
    ].join(' '),
  );

  const base = {
    headCommit: head,
    headCommitStale: false,
    workingTreeDirty: dirty,
    events,
    gate: null,
    progressCrossCheck: { kind: 'no-tour' } as CrossCheck,
    headCommitCheck: { kind: 'current' } as HeadCommitCheck,
  };

  if (block.kind === 'malformed' && !dirty) {
    events.push(
      `The open-tour block does not parse either (${block.field}: ${block.problem}), and the tree is clean, so nothing left says whether a tour is open. The unreadable marker is left where it is, so the next run meets the same evidence rather than an absent marker.`,
    );
    return unresolved({
      ...base,
      discardedMarker: null,
      unresolved: [
        `the marker is unreadable (${input.read.reason}) and the open-tour block does not parse (${block.field}: ${block.problem}), so neither record says whether a tour is open (SDD §4.4 step 1).`,
      ],
    });
  }

  const discardedMarker = preserve(root, now);

  // A dirty tree is death mid-job whatever either record says (step 3), and a
  // block with rows names the tour and the job it died in.
  if (dirty) {
    events.push('The working tree is dirty, which is death mid-job (SDD §4.4 step 3).');
    return finish(root, {
      ...base,
      state: 'EXECUTING',
      nextAction: 'RESUME_EXECUTION',
      marker: reconstructed(block, head, now),
      discardedMarker,
      unresolved: [],
    });
  }

  if (block.kind === 'open') {
    events.push(
      'The tree is clean and the open-tour block carries rows, which is a tour that was opened: the state is reconstructed as EXECUTING and the drive resumes at the first job whose acceptance criterion does not pass (SDD §4.4, D-96).',
    );
    return finish(root, {
      ...base,
      state: 'EXECUTING',
      nextAction: 'RESUME_EXECUTION',
      marker: reconstructed(block, head, now),
      discardedMarker,
      unresolved: [],
    });
  }

  events.push(
    'The tree is clean and the Open tour section states that no tour is open, which is no tour: the repository is at a closed boundary (SDD §4.4, D-96).',
  );
  return finish(root, {
    ...base,
    state: 'IDLE',
    nextAction: 'PLAN_TOUR',
    marker: {
      state: 'IDLE',
      tourId: null,
      jobIndex: null,
      interruptedState: null,
      attemptCount: 0,
      gateId: null,
      disposition: null,
      headCommit: head,
      updatedAt: now.toISOString(),
    },
    discardedMarker,
    unresolved: [],
  });
}

/**
 * The marker for a state derived from the repository rather than from a
 * record, adopting what the block says where it can be read.
 *
 * `attempt_count` starts at zero and the disposition at null: both are the
 * marker's own facts and the discarded marker is the only place they were, so
 * nothing here can recover them. A fresh budget is the safe direction, since
 * the alternative is a tour that raises the tour-budget gate on a count nobody
 * can produce evidence for.
 */
function reconstructed(block: OpenTourRead, head: string | null, now: Date): StateMarker {
  return {
    state: 'EXECUTING',
    tourId: block.kind === 'open' ? block.block.tourId : null,
    jobIndex: block.kind === 'open' ? firstUnfinishedRow(block) : null,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: null,
    headCommit: head,
    updatedAt: now.toISOString(),
  };
}

/** Step 5: the corrected marker is on disk before the caller sees the result. */
function finish(root: string, result: ResumeResult): ResumeResult {
  if (result.marker !== null) {
    ensureRunDir(root);
    writeMarker(root, result.marker);
  }
  return result;
}
