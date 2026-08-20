import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { ensureRunDir, wardroomPaths } from '../config/paths.js';
import { headCommit, isWorkingTreeDirty } from './git.js';
import { type StateMarker, type TourState, readMarker, writeMarker } from './marker.js';

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

/** SDD §4.4 step 4: what each state resumes as. */
function actionFor(state: TourState, marker: StateMarker, attemptBudget: number): NextAction {
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
      return 'REPRESENT_GATE';
    case 'FAILED':
      return marker.attemptCount < attemptBudget ? 'RETRY_EXECUTION' : 'RAISE_TOUR_BUDGET_GATE';
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
        headCommit: head,
        updatedAt: now.toISOString(),
      },
      headCommit: head,
      headCommitStale: false,
      workingTreeDirty: dirty,
      discardedMarker: null,
      events,
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

  return finish(root, {
    state: marker.state,
    nextAction: actionFor(marker.state, marker, attemptBudget),
    marker: { ...marker, headCommit: head, updatedAt: now.toISOString() },
    headCommit: head,
    headCommitStale,
    workingTreeDirty: dirty,
    discardedMarker: null,
    events,
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
