import type { StateMarker, TourState } from '../state/marker.js';

/**
 * Refuses a drive entered from the wrong state (SDD §3.2).
 *
 * Each drive owns one state and does not decide which state that is: the run
 * loop reads the marker and dispatches, and a drive that quietly worked from
 * the wrong one would move a tour through a transition the table does not
 * have. Four drives had written this check out separately, which is three
 * chances for the wording, and eventually the rule, to differ.
 */
export function assertDrivenState(marker: StateMarker, expected: TourState): void {
  if (marker.state === expected) return;
  throw new Error(
    `the ${expected} drive was entered from ${marker.state}. It drives one state and does not decide which state that is (SDD §3.2).`,
  );
}
