import type { ProjectConfig } from '../config/schema.js';
import { raiseTourBudgetGate } from '../gates/tour-budget.js';
import { type OpenTourBlock, readOpenTour } from '../progress/open-tour.js';
import {
  type LastFailure,
  failureEvidence,
  readLastFailure,
  writeLastFailure,
} from '../state/last-failure.js';
import { advance } from '../state/machine.js';
import type { StateMarker } from '../state/marker.js';
import { assertDrivenState } from './state-guard.js';

/**
 * The `PLANNING` drive (SDD §3.2, §4.1, §4.4 step 4).
 *
 * Planning is where the tour record is created and its identifier minted
 * (§3.3, §4.1 step 7, D-45), so everything before the block is written happens
 * under no tour at all. That is what makes the failure route out of this state
 * different from the one out of `VERIFYING`: there is nothing to abandon, and
 * the gate it eventually raises names no tour (D-50, D-70).
 *
 * The loop owns the marker and the failure record. The session owns the block:
 * §4.1 step 7 has the PM write it, and it is the durable trace of the plan.
 */

/**
 * The PM session, as this loop needs it.
 *
 * Injected for the same reason the Implementer session is (§4.2): a session is
 * a live SDK query against an account, and a loop that built its own could not
 * be exercised without one.
 */
export interface PmSession {
  /**
   * Runs one planning attempt, writing the open-tour block into PROGRESS.
   *
   * The loop does not read what it returns. §4.1 step 7 makes the block the
   * output, and a session's account of what it wrote is not the block: the
   * loop reads the file, which is what a resumed run would read too.
   */
  readonly plan: () => Promise<void>;
}

export interface DrivePlanningInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as resumption left it. Must read `PLANNING`. */
  readonly marker: StateMarker;
  readonly session: PmSession;
  readonly now?: () => Date;
}

export type PlanningResult =
  | {
      readonly kind: 'planned';
      readonly marker: StateMarker;
      readonly block: OpenTourBlock;
      /** Attempts this run spent, which a resumed run answers differently. */
      readonly attemptsSpent: number;
    }
  | {
      readonly kind: 'gated';
      readonly marker: StateMarker;
      readonly gateId: string;
      readonly failure: LastFailure | null;
    };

/**
 * Plans a tour, retrying while the attempt budget holds and raising the
 * tour-budget gate when it does not.
 *
 * The gate is raised and the marker left `GATED`; blocking on the owner's
 * answer belongs to the run loop that owns the process, not to one state's
 * drive. Rejection there leaves `IDLE` and the run exits, since no tour record
 * was created and there is nothing to abandon (D-50), which is likewise the
 * run loop's to apply.
 */
export async function drivePlanning(input: DrivePlanningInput): Promise<PlanningResult> {
  assertDrivenState(input.marker, 'PLANNING');

  const now = input.now ?? (() => new Date());
  const rules = { attemptBudget: input.config.attemptBudget };
  let marker = input.marker;
  let attemptsSpent = 0;

  // A floor under the loop, independent of the counter it reads. Every exit
  // below depends on `attempt_count` moving, and a counter that stops moving
  // turns this into the unbounded retry FR-1.3 and D-50 exist to forbid, with
  // no gate ever raised and nothing on disk saying why. One attempt more than
  // the budget can ever allow is enough to catch that and still never bind a
  // run the budget itself has not already bound.
  const ceiling = input.config.attemptBudget + 1;

  for (;;) {
    if (attemptsSpent > ceiling) {
      throw new Error(
        `planning ran ${attemptsSpent} attempts against a budget of ${input.config.attemptBudget} without the attempt counter moving. That is the unbounded retry FR-1.3 forbids, so the loop stops rather than spinning (D-50).`,
      );
    }
    // The block first, on every pass. On the first it is the D-49 adoption: a
    // complete block under a PLANNING marker is the ordinary outcome of a
    // death at §4.1 step 7's seam, not a half-written one. On later passes it
    // is how the loop reads what the session just wrote, because the session's
    // account of its own output is not the output.
    const read = readOpenTour(input.root, input.config.docRoot);
    if (read.kind === 'open') {
      return {
        kind: 'planned',
        marker: advance(
          input.root,
          marker,
          { type: 'plan-complete', tourId: read.block.tourId },
          rules,
          now(),
        ).marker,
        block: read.block,
        attemptsSpent,
      };
    }

    // Only a partial block is a failure. An absent one is the ordinary start
    // of planning, and counting it would spend an attempt before the session
    // had been asked for anything.
    if (read.kind === 'malformed' && attemptsSpent > 0) {
      const record: LastFailure = {
        kind: 'planning',
        attempt: marker.attemptCount + 1,
        field: read.field,
        problem: read.problem,
      };
      writeLastFailure(input.root, record);
      marker = advance(input.root, marker, { type: 'plan-failed' }, rules, now()).marker;
    }

    if (marker.attemptCount >= input.config.attemptBudget) {
      const failure = readLastFailure(input.root);
      const raised = raiseTourBudgetGate({
        root: input.root,
        config: input.config,
        marker,
        reason: 'budget-spent',
        evidence: failureEvidence(failure),
        now: now(),
      });
      return { kind: 'gated', marker: raised.marker, gateId: raised.gateId, failure };
    }

    await input.session.plan();
    attemptsSpent += 1;
  }
}
