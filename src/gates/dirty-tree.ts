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
 * transition, with the pre-record identity SDD §3.2 fixes: `interrupted_state`
 * is IDLE, `job_index` is 0, and `tour_id` is null because no tour record
 * exists (D-45, D-70).
 *
 * It takes no identifier and names none. Nothing mints one at this approval:
 * the gate is a decision about the working tree, the tour record is created at
 * the end of planning, and the identifier is minted there and nowhere else
 * (§3.3, D-45, D-70). Naming a tour here would put a second minting site in
 * the system and name a tour that may never be planned, since rejection leaves
 * IDLE and the run exits.
 *
 * An empty change list is not refused here: the preview contract refuses it
 * at enqueue (D-32), and a second refusal ahead of that one would be a second
 * home for the rule.
 */
export function dirtyTreeGateRequest(changes: readonly TreeChange[]): EnqueueRequest {
  const count = `${changes.length} uncommitted change${changes.length === 1 ? '' : 's'}`;
  return {
    gateClass: 'dirty-tree',
    tourId: null,
    jobIndex: 0,
    interruptedState: 'IDLE',
    what: `Begin planning over a working tree carrying ${count}`,
    why: 'FR-1.6: orchestration at IDLE on a dirty tree does not begin planning and does not touch the tree; the owner decides (D-36)',
    preview: { kind: 'dirty-tree', changes },
  };
}
