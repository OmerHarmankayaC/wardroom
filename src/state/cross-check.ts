import type { OpenTourRead } from '../progress/open-tour.js';
import { commitExists, isAncestorOf } from './git.js';
import type { StateMarker, TourState } from './marker.js';

/**
 * The open-tour cross-check (SDD §4.4, D-96, corrected by D-100 and D-104,
 * B-9).
 *
 * Two pairs: the marker's `tour_id` against the block's tour, and its
 * `job_index` against the first row in the block whose status is not done. It
 * compares them **for reconcilable lag, not for identity** (D-104).
 *
 * Identity was the first rule written here and it was wrong in a way only a
 * running kill test showed. §4.2 fixes the write order: the block is written
 * and committed first (D-65) and the marker after (D-47), so the two records
 * legitimately differ in exactly the windows §4.4's table exists for. A check
 * that treats every difference as a conflict detects nothing; it deadlocks,
 * permanently, at the points a death is most likely, and three of five kill
 * points did.
 *
 * **The direction is an invariant: the block leads and the marker lags.**
 * Nothing writes the marker before the block, so a marker ahead of the block
 * is not a window at all. It is a lost block write or a hand edit.
 *
 * **`head_commit` is not one of those pairs (D-100).** That comparison has
 * `.git` on one side, so it is a record measured against evidence rather than
 * two records disagreeing. It is checked here too, by {@link checkHeadCommit},
 * under step 2's rule rather than this one's.
 */

/** One pair that could not be reconciled, with both readings and the rule. */
export interface Disagreement {
  readonly pair: 'tour_id' | 'job_index';
  /** What the marker said, rendered for a reader. */
  readonly marker: string;
  /** What the open-tour block said. */
  readonly block: string;
  /** Why the two cannot be reconciled, in the terms §4.4 states the rule in. */
  readonly rule: string;
}

export type CrossCheck =
  /** The two records say the same thing; resumption proceeds by step 4. */
  | { readonly kind: 'aligned' }
  /**
   * The block is exactly one row ahead: the job is finished and committed and
   * the marker has not been advanced yet (D-97's second window).
   *
   * Permitted, and the one reading that used to deadlock. Where resumption
   * picks up is not decided from either record: step 4 resumes at the first
   * job whose acceptance criterion does not pass, and the criterion and `.git`
   * are the evidence (D-65).
   */
  | { readonly kind: 'lagging'; readonly markerJobIndex: number; readonly blockRow: number }
  /** Neither record names a tour, so there is nothing to compare. */
  | { readonly kind: 'no-tour' }
  /**
   * The block names a tour and the marker does not, in `PLANNING`.
   *
   * §4.1 step 7 writes the block before the marker, so a finished plan under a
   * `PLANNING` marker is the ordinary outcome of a death at that seam and the
   * block is adopted (D-49).
   */
  | { readonly kind: 'adopting'; readonly blockTour: string }
  /**
   * The marker names a tour and the block does not, in `CLOSING`.
   *
   * §4.6 step 6 clears the block before the closure commit, so a death between
   * the two leaves exactly this.
   */
  | { readonly kind: 'block-cleared'; readonly markerTour: string }
  /** No legitimate sequence produces this pair of readings. */
  | { readonly kind: 'conflict'; readonly disagreements: readonly Disagreement[] }
  /**
   * The marker names a tour and the block cannot be read.
   *
   * Neither record can be trusted and there is no rule for choosing, which is
   * the answer a conflict gets.
   */
  | { readonly kind: 'unreadable-block'; readonly field: string; readonly problem: string };

/** Whether this reading stops resumption. One home, so no caller decides again. */
export function isCrossCheckConflict(check: CrossCheck): boolean {
  return check.kind === 'conflict' || check.kind === 'unreadable-block';
}

/**
 * Where the block says the tour has got to: the position of the first row
 * whose status is not done.
 *
 * Zero-based, because that is what `job_index` counts. The marker is moved to
 * `index + 1` at each job boundary (§4.2, D-47), so after one finished job it
 * reads 1 and the first row not done is the second, at position 1. A block
 * whose rows are all done answers with the row count, which is what the marker
 * reads at the last boundary.
 */
export function firstUnfinishedRow(read: Extract<OpenTourRead, { kind: 'open' }>): number {
  const at = read.block.jobs.findIndex((job) => job.status !== 'done');
  return at === -1 ? read.block.jobs.length : at;
}

function render(value: string | number | null): string {
  return value === null ? 'nothing' : String(value);
}

function conflict(...disagreements: Disagreement[]): CrossCheck {
  return { kind: 'conflict', disagreements };
}

/** The state a marker may name a tour in against a block that names none. */
const BLOCK_CLEARED_IN: TourState = 'CLOSING';
/** The state a block may name a tour in against a marker that names none. */
const BLOCK_ADOPTED_IN: TourState = 'PLANNING';

/**
 * Compares `job_index` against the first not-done row, in the one direction
 * the write order allows.
 */
function compareRows(marker: StateMarker, blockRow: number, tour: string): CrossCheck {
  const jobIndex = marker.jobIndex;
  if (jobIndex === null) {
    return conflict({
      pair: 'job_index',
      marker: 'nothing',
      block: `${blockRow} (the first row not marked done)`,
      rule: `the marker names ${tour} and no job at all, which no transition produces: the identifier and the index are written together at the end of planning (§4.1 step 7, D-45)`,
    });
  }

  if (jobIndex === blockRow) return { kind: 'aligned' };

  if (blockRow === jobIndex + 1) {
    // The lag §4.2's write order creates on purpose: the status update rode
    // into the commit (D-65) and the marker has not been advanced yet (D-47).
    return { kind: 'lagging', markerJobIndex: jobIndex, blockRow };
  }

  if (blockRow > jobIndex + 1) {
    return conflict({
      pair: 'job_index',
      marker: render(jobIndex),
      block: `${blockRow} (the first row not marked done)`,
      rule: 'the block is more than one row ahead, and no window skips a job: one boundary moves one row and writes the marker after it (SDD §4.4, D-104)',
    });
  }

  return conflict({
    pair: 'job_index',
    marker: render(jobIndex),
    block: `${blockRow} (the first row not marked done)`,
    rule: 'the marker is ahead of the block, and the marker cannot lead: nothing writes it before the block, so this is a lost block write or a hand edit rather than a window (SDD §4.4, D-104)',
  });
}

/**
 * Classifies the two readings.
 *
 * Both sides are records, so nothing here corrects one from the other. What is
 * evidence sits one level down and is used where it exists: a job's acceptance
 * criterion for the job (D-65) and `.git` for a commit (step 2).
 */
export function crossCheckOpenTour(marker: StateMarker, read: OpenTourRead): CrossCheck {
  if (read.kind === 'malformed') {
    // A marker naming no tour has nothing to compare against, whatever the
    // block says: a half-written block under a PLANNING marker is the ordinary
    // outcome of a death mid-plan, which step 4 discards and re-plans (D-49),
    // and at IDLE there is no tour for the block to be about.
    if (marker.tourId === null) return { kind: 'no-tour' };
    return { kind: 'unreadable-block', field: read.field, problem: read.problem };
  }

  const blockTour = read.kind === 'open' ? read.block.tourId : null;

  if (marker.tourId === null && blockTour === null) return { kind: 'no-tour' };

  if (marker.tourId !== null && blockTour === null) {
    if (marker.state === BLOCK_CLEARED_IN)
      return { kind: 'block-cleared', markerTour: marker.tourId };
    return conflict({
      pair: 'tour_id',
      marker: marker.tourId,
      block: 'no tour is open',
      rule: `the block is cleared before the closure commit and nowhere else (§4.6 step 6), so a marker naming a tour against an empty block is a window only in ${BLOCK_CLEARED_IN}, and this marker reads ${marker.state}`,
    });
  }

  if (marker.tourId === null && blockTour !== null) {
    if (marker.state === BLOCK_ADOPTED_IN) return { kind: 'adopting', blockTour };
    return conflict({
      pair: 'tour_id',
      marker: 'nothing',
      block: blockTour,
      rule: `the block is written before the marker at the end of planning (§4.1 step 7), so a block naming a tour against a nameless marker is a window only in ${BLOCK_ADOPTED_IN}, and this marker reads ${marker.state}`,
    });
  }

  if (marker.tourId !== blockTour) {
    return conflict({
      pair: 'tour_id',
      marker: marker.tourId as string,
      block: blockTour as string,
      rule: 'the two records name different tours, which no sequence produces: one tour is open at a time (SRS §3.5) and its identifier is minted once (D-45)',
    });
  }

  return compareRows(
    marker,
    firstUnfinishedRow(read as Extract<OpenTourRead, { kind: 'open' }>),
    blockTour as string,
  );
}

/**
 * What `head_commit` is against `HEAD` (SDD §4.4 step 2, refined by D-100).
 *
 * `current` covers equality and a marker naming no commit at all, which is
 * what an unborn repository leaves.
 */
export type HeadCommitCheck =
  | { readonly kind: 'current' }
  /** The marker is behind: work completed after the last marker write. */
  | { readonly kind: 'behind'; readonly markerCommit: string; readonly head: string }
  /**
   * The marker names work this repository does not have.
   *
   * Not late work, and not a record to be corrected from git: it is what a
   * history rewrite, a wrong clone or a fabricated marker leaves behind.
   * Reconstructing from git here would silently adopt the repository's version
   * of a history the marker says was different.
   */
  | {
      readonly kind: 'unreachable';
      readonly markerCommit: string;
      readonly head: string | null;
      readonly reason: string;
    };

/**
 * Applies step 2's rule with D-100's refinement: git wins where the marker's
 * commit is reachable from `HEAD`.
 *
 * The reachability test is D-78's, one procedure over: closure refuses a
 * commit that exists as an object and sits on nobody's branch, for the same
 * reason. An object that `HEAD` cannot reach is not this history's past.
 */
export function checkHeadCommit(
  root: string,
  markerCommit: string | null,
  head: string | null,
): HeadCommitCheck {
  if (markerCommit === null || markerCommit === head) return { kind: 'current' };

  if (head === null) {
    return {
      kind: 'unreachable',
      markerCommit,
      head,
      reason:
        'the repository has no commits at all, so nothing can reach the commit the marker names',
    };
  }
  if (!commitExists(root, markerCommit)) {
    return {
      kind: 'unreachable',
      markerCommit,
      head,
      reason: 'the repository has no such object',
    };
  }
  if (!isAncestorOf(root, markerCommit, head)) {
    return {
      kind: 'unreachable',
      markerCommit,
      head,
      reason: `it exists and HEAD (${head}) cannot reach it, so it is on no branch this repository would have grown from`,
    };
  }
  return { kind: 'behind', markerCommit, head };
}
