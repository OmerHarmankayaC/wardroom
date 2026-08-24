import type { ProjectConfig } from '../config/schema.js';
import type { LastFailure } from '../state/last-failure.js';
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
  /**
   * The evidence §3.1 requires: the failure record this decision is about, in
   * its own shape (D-81).
   *
   * Null for `no-definition` alone, where the gate is raised with no attempt
   * spent and so no record was ever written (D-71). That is a determinate fact
   * about the occasion rather than a field nobody filled, and `detail` carries
   * what happened instead.
   */
  readonly failure: LastFailure | null;
  /** Why the definition could not be read, for the `no-definition` occasion. */
  readonly detail?: string;
  readonly now: Date;
}

export interface TourBudgetGateRaised {
  readonly marker: StateMarker;
  readonly gateId: string;
}

const WORDING: Record<
  TourBudgetReason,
  { what: (marker: StateMarker) => string; why: (detail: string | undefined) => string }
> = {
  'budget-spent': {
    what: (marker) =>
      `Grant a fresh attempt budget after ${marker.attemptCount} failed attempts, or stop`,
    why: () =>
      'FR-1.3: the attempt budget is spent, and retrying without a bound is the shape that requirement exists to forbid',
  },
  'no-definition': {
    what: () => 'Decide what to do about a tour that cannot be verified at all',
    // The detail is appended rather than dropped. This occasion carries no
    // failure record (D-71), so the why line is the only place the reason the
    // definition could not be read survives into the entry.
    why: (detail) =>
      `FR-1.5: an empty or missing green definition is a verification failure with the reason stated, and no retry can change it, so the budget is not spent one attempt at a time on it (D-71)${detail === undefined ? '' : `. ${detail}`}`,
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
      why: wording.why(input.detail),
      preview: {
        kind: 'tour-budget',
        attemptCount: input.marker.attemptCount,
        // The record itself, not a rendering of it. A surface formats it for
        // the owner (§5.2), and flattening it here would make that decision in
        // the wrong place and would drop a planning failure entirely, since it
        // has no command and no exit code (D-81).
        failure: input.failure,
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
