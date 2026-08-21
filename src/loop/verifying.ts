import type { ProjectConfig } from '../config/schema.js';
import { raiseTourBudgetGate } from '../gates/tour-budget.js';
import {
  type LastFailure,
  failedRoute,
  failureEvidence,
  readLastFailure,
  writeLastFailure,
} from '../state/last-failure.js';
import { advance } from '../state/machine.js';
import type { StateMarker } from '../state/marker.js';
import { type VerifyRunner, runVerification } from '../verify/run.js';
import { assertDrivenState } from './state-guard.js';

/**
 * `VERIFYING` and `FAILED` (SDD §3.2, §4.3, §4.4 step 4).
 *
 * This run is the orchestrator's own and is over the tour rather than the job.
 * It alone moves the state machine and spends the budget; the commit gate runs
 * the same command list at every job boundary and changes nothing (D-58).
 *
 * What a failure leaves behind is `last-failure.json`, which both the retry
 * and the gate's preview read. Re-running to reconstruct it is not equivalent:
 * a re-run can pass, leaving the owner asked to decide about a failure that no
 * longer reproduces (D-48).
 */

export interface DriveVerifyingInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as resumption left it. Must read `VERIFYING`. */
  readonly marker: StateMarker;
  /** Injected so a suite need not be spent proving the state machine moves. */
  readonly runVerification?: VerifyRunner;
  readonly now?: () => Date;
}

export type VerifyingResult =
  | { readonly kind: 'green'; readonly marker: StateMarker }
  | { readonly kind: 'failed'; readonly marker: StateMarker; readonly record: LastFailure }
  | { readonly kind: 'gated'; readonly marker: StateMarker; readonly gateId: string };

/**
 * Runs the green definition over the tour and moves the state machine by what
 * it found (§4.3).
 *
 * Three answers, not two. A missing definition is kept apart from a failed
 * command because an empty list read as "nothing failed" is the silent pass
 * FR-1.5 forbids, and because the two have different futures: a command may
 * pass on the next attempt, an absent definition cannot change by being run
 * again. So it raises the gate at once rather than spending the budget one
 * attempt at a time on a question only the owner can answer (D-71).
 */
export function driveVerifying(input: DriveVerifyingInput): VerifyingResult {
  assertDrivenState(input.marker, 'VERIFYING');

  const now = (input.now ?? (() => new Date()))();
  const rules = { attemptBudget: input.config.attemptBudget };
  const result = (input.runVerification ?? runVerification)(input.root, input.config.verify);

  if (result.kind === 'green') {
    return {
      kind: 'green',
      marker: advance(input.root, input.marker, { type: 'green' }, rules, now).marker,
    };
  }

  if (result.kind === 'no-definition') {
    const raised = raiseTourBudgetGate({
      root: input.root,
      config: input.config,
      marker: input.marker,
      reason: 'no-definition',
      evidence: result.reason,
      now,
    });
    return { kind: 'gated', marker: raised.marker, gateId: raised.gateId };
  }

  // The record first, then the transition. A death between the two leaves a
  // record naming an attempt the counter has not reached yet, which reads as a
  // stale record; the reverse leaves a spent attempt with no evidence, and
  // that is the one the tour-budget preview cannot be built from.
  const record: LastFailure = {
    kind: 'verification',
    attempt: input.marker.attemptCount + 1,
    command: result.failure.command,
    exitCode: result.failure.exitCode,
    output: result.failure.output,
  };
  writeLastFailure(input.root, record);

  return {
    kind: 'failed',
    marker: advance(input.root, input.marker, { type: 'verification-failed' }, rules, now).marker,
    record,
  };
}

export interface DriveFailedInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as resumption left it. Must read `FAILED`. */
  readonly marker: StateMarker;
  readonly now?: () => Date;
}

export type FailedResult =
  | {
      readonly kind: 'retry';
      readonly marker: StateMarker;
      /** The failure the retry is given as input (§3.2). */
      readonly failure: LastFailure;
    }
  | { readonly kind: 'gated'; readonly marker: StateMarker; readonly gateId: string }
  /** No record survives, so the tour is verified again rather than guessed at. */
  | { readonly kind: 'reverify'; readonly marker: StateMarker };

/**
 * Decides what a tour in `FAILED` does next, from the record and the counter
 * and nothing else (§4.4 step 4).
 *
 * Nothing here consults the run that failed. A process can die in `FAILED`, so
 * the deciding run may have no memory of the failure at all; everything it
 * decides from is on disk. Where the record is absent or unreadable, the tour
 * is verified again rather than guessed at: with no evidence there is nothing
 * to say which side of the budget it was on, and either guess is worse than
 * looking.
 */
export function driveFailed(input: DriveFailedInput): FailedResult {
  if (input.marker.state !== 'FAILED') {
    throw new Error(
      `the FAILED drive was entered from ${input.marker.state}. It drives one state and does not decide which state that is (SDD §3.2).`,
    );
  }

  const now = (input.now ?? (() => new Date()))();
  const rules = { attemptBudget: input.config.attemptBudget };
  const failure = readLastFailure(input.root);
  const route = failedRoute(input.marker.attemptCount, input.config.attemptBudget, failure);

  if (route === 'reverify') {
    return {
      kind: 'reverify',
      marker: advance(input.root, input.marker, { type: 'reverify' }, rules, now).marker,
    };
  }

  if (route === 'retry') {
    return {
      kind: 'retry',
      marker: advance(input.root, input.marker, { type: 'retry' }, rules, now).marker,
      failure: failure as LastFailure,
    };
  }

  const raised = raiseTourBudgetGate({
    root: input.root,
    config: input.config,
    marker: input.marker,
    reason: 'budget-spent',
    evidence: failureEvidence(failure),
    now,
  });
  return { kind: 'gated', marker: raised.marker, gateId: raised.gateId };
}
