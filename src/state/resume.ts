import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { ensureRunDir, wardroomPaths } from '../config/paths.js';
import type { GateEntry } from '../gates/schema.js';
import { readEntry } from '../gates/store.js';
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
 * Scope boundary (BACKLOG D-21). Step 2's cross-check against the open-tour
 * block in PROGRESS.md is not implemented: it needs a grammar that no document
 * fixes yet, and inventing one inside an implementation module would be doc
 * work smuggled into code (B-9). Every result carries `progressCrossCheck:
 * 'unavailable'` so no caller can mistake this for the whole procedure (T-5).
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
  /** The marker was unreadable and git alone cannot decide. Never `PLAN_TOUR`. */
  | 'RECONSTRUCT_FROM_DOCUMENTS';

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
  /** SDD §4.4 step 2 against PROGRESS.md is deferred to B-9 (D-21, T-5). */
  readonly progressCrossCheck: 'unavailable';
}

const CROSS_CHECK_EVENT =
  'The PROGRESS open-tour cross-check (SDD §4.4 step 2) did not run: it is deferred to B-9 ' +
  '(D-21). Resumption here is validated against git only, so K-3 is not met (T-5).';

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

/**
 * Reconstructs the next action for a project root and writes the corrected
 * marker before returning, so a second death lands on the corrected state
 * instead of repeating this reconstruction (step 5).
 */
export function resume(root: string, now: Date = new Date()): ResumeResult {
  const { attemptBudget } = loadConfig(root);
  const head = headCommit(root);
  const dirty = isWorkingTreeDirty(root);
  const events: string[] = [CROSS_CHECK_EVENT];

  const read = readMarker(root);

  if (read.kind === 'unreadable') {
    events.push(
      [
        `The state marker was present but unreadable (${read.reason}); it was discarded,`,
        'not treated as absent, because an absent marker means a repository that was never',
        'run and this one plainly was (D-20).',
      ].join(' '),
    );
    const discardedMarker = preserve(root, now);

    // Step 3 is the only repository evidence available without the open-tour
    // block: a dirty tree is death mid-job, whatever the marker failed to say.
    if (dirty) {
      events.push('The working tree is dirty, which is death mid-job (SDD §4.4 step 3).');
      return finish(root, {
        state: 'EXECUTING',
        nextAction: 'RESUME_EXECUTION',
        marker: reconstructed(head, now),
        headCommit: head,
        headCommitStale: false,
        workingTreeDirty: dirty,
        discardedMarker,
        events,
        gate: null,
        progressCrossCheck: 'unavailable',
      });
    }

    events.push(
      'The working tree is clean, so git cannot tell an open tour at a job boundary from no ' +
        'tour at all. The state is left unresolved rather than reported as IDLE.',
    );
    return {
      state: null,
      nextAction: 'RECONSTRUCT_FROM_DOCUMENTS',
      marker: null,
      headCommit: head,
      headCommitStale: false,
      workingTreeDirty: dirty,
      discardedMarker,
      events,
      gate: null,
      progressCrossCheck: 'unavailable',
    };
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
        headCommit: head,
        updatedAt: now.toISOString(),
      },
      headCommit: head,
      headCommitStale: false,
      workingTreeDirty: dirty,
      discardedMarker: null,
      events,
      gate: null,
      progressCrossCheck: 'unavailable',
    });
  }

  const marker = read.marker;
  const headCommitStale = marker.headCommit !== head;
  if (headCommitStale) {
    events.push(
      [
        `The marker names ${marker.headCommit ?? 'no commit'} but HEAD is ${head ?? 'unborn'};`,
        'the repository wins, so work completed after the last marker write is not lost.',
      ].join(' '),
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
    nextAction: actionFor(marker.state, marker, attemptBudget, gate, readLastFailure(root)),
    marker: { ...marker, headCommit: head, updatedAt: now.toISOString() },
    headCommit: head,
    headCommitStale,
    workingTreeDirty: dirty,
    discardedMarker: null,
    events,
    gate,
    progressCrossCheck: 'unavailable',
  });
}

/** The marker for a state derived from the repository rather than from a record. */
function reconstructed(head: string | null, now: Date): StateMarker {
  return {
    state: 'EXECUTING',
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
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
