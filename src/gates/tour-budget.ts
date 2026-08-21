import type { ProjectConfig } from '../config/schema.js';
import { advance } from '../state/machine.js';
import type { StateMarker } from '../state/marker.js';
import { enqueue } from './queue.js';

/**
 * FR-1.3's gate, raised from the one place that knows how to raise it.
 *
 * Three states reach it: `PLANNING` and `FAILED` when the attempt budget is
 * spent, and `VERIFYING` at once where the green definition is missing and no
 * retry could change that (D-50, D-71). The identity of the entry is read from
 * the marker rather than passed alongside it, so a gate raised before any tour
 * record exists carries a null `tour_id` because the marker does (D-45, D-70),
 * and one raised inside a tour names it for the same reason.
 *
 * One home because the two callers had begun to differ in ways nobody chose:
 * what the entry said, which fields it filled, and whether the transition
 * carried the flag that lets it be raised on an unspent budget.
 */

/** Why the budget conversation is being had, which is what the owner reads. */
export type TourBudgetReason = 'budget-spent' | 'no-definition';

export interface TourBudgetGateInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker the gate is raised from; it supplies the entry's identity. */
  readonly marker: StateMarker;
  readonly reason: TourBudgetReason;
  /** The evidence §3.1 requires: the failure this decision is about. */
  readonly evidence: string;
  readonly now: Date;
}

export interface TourBudgetGateRaised {
  readonly marker: StateMarker;
  readonly gateId: string;
}

const WORDING: Record<TourBudgetReason, { what: (marker: StateMarker) => string; why: string }> = {
  'budget-spent': {
    what: (marker) =>
      `Grant a fresh attempt budget after ${marker.attemptCount} failed attempts, or stop`,
    why: 'FR-1.3: the attempt budget is spent, and retrying without a bound is the shape that requirement exists to forbid',
  },
  'no-definition': {
    what: () => 'Decide what to do about a tour that cannot be verified at all',
    why: 'FR-1.5: an empty or missing green definition is a verification failure with the reason stated, and no retry can change it, so the budget is not spent one attempt at a time on it (D-71)',
  },
};

/** Enqueues the entry and moves the marker to `GATED` naming it (D-62). */
export function raiseTourBudgetGate(input: TourBudgetGateInput): TourBudgetGateRaised {
  const wording = WORDING[input.reason];
  const entry = enqueue(
    input.root,
    {
      gateClass: 'tour-budget',
      tourId: input.marker.tourId,
      jobIndex: input.marker.jobIndex,
      interruptedState: input.marker.state,
      what: wording.what(input.marker),
      why: wording.why,
      preview: {
        kind: 'tour-budget',
        attemptCount: input.marker.attemptCount,
        lastFailureOutput: input.evidence,
      },
    },
    { now: input.now },
  );

  return {
    marker: advance(
      input.root,
      input.marker,
      {
        type: 'raise-gate',
        gateClass: 'tour-budget',
        gateId: entry.gateId,
        // Only the unretryable case may be raised on an unspent budget.
        ...(input.reason === 'no-definition' ? { unretryable: true } : {}),
      },
      { attemptBudget: input.config.attemptBudget },
      input.now,
    ).marker,
    gateId: entry.gateId,
  };
}
