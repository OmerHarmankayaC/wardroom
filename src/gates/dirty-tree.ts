import type { TreeChange } from '../state/git.js';
import type { EnqueueRequest } from './queue.js';

/**
 * The dirty-tree gate raised at tour open (SRS FR-1.6, BACKLOG D-36).
 *
 * Starting orchestration at IDLE on a tree that is not clean must not begin
 * planning and must not touch the tree: the owner's half-done work is exactly
 * what a silent proceed would sweep into the tour's first commit. Approval
 * opens the tour over the acknowledged tree; rejection leaves the repository
 * untouched and the run exits. There is no third outcome.
 */

/**
 * The enqueue request for a dirty tree found at the IDLE to PLANNING
 * transition, with the pre-tour identity the SDD §3.2 note fixes:
 * `interrupted_state` is IDLE because no tour exists yet, `job_index` is 0
 * for the same reason, and `tour_id` is the id the tour will carry, knowable
 * before planning because identifiers are monotonic per project (SRS §3.3).
 *
 * An empty change list is not refused here: the preview contract refuses it
 * at enqueue (D-32), and a second refusal ahead of that one would be a second
 * home for the rule.
 */
export function dirtyTreeGateRequest(
  tourId: string,
  changes: readonly TreeChange[],
): EnqueueRequest {
  return {
    gateClass: 'dirty-tree',
    tourId,
    jobIndex: 0,
    interruptedState: 'IDLE',
    what: `Open ${tourId} over a working tree carrying ${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}`,
    why: 'FR-1.6: orchestration at IDLE on a dirty tree does not begin planning and does not touch the tree; the owner decides (D-36)',
    preview: { kind: 'dirty-tree', changes },
  };
}
