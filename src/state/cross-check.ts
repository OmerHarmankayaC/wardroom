import type { OpenTourRead } from '../progress/open-tour.js';
import { commitExists, isAncestorOf } from './git.js';
import type { StateMarker } from './marker.js';

/**
 * The open-tour cross-check (SDD §4.4, D-96 corrected by D-100, B-9).
 *
 * Two pairs, and it is a detector rather than an arbiter: the marker's
 * `tour_id` against the block's tour, and the marker's `job_index` against the
 * first row in the block whose status is not done. Agreement on both lets
 * resumption proceed; disagreement on either stops it, because no rule can
 * pick a winner between two records and neither is evidence (§3.3).
 *
 * **`head_commit` is not one of those pairs (D-100).** It was written as a
 * third pair, which contradicted §4.4 step 2 and the window table in the same
 * section, and contradicted the reasoning above: that comparison has `.git` on
 * one side, so it is not two records disagreeing but a record measured against
 * evidence. It is checked here too, by {@link checkHeadCommit}, under step 2's
 * rule rather than this one's.
 */

/** One pair that did not agree, with both readings, neither preferred. */
export interface Disagreement {
  readonly pair: 'tour_id' | 'job_index';
  /** What the marker said, rendered for a reader. */
  readonly marker: string;
  /** What the open-tour block said. */
  readonly block: string;
}

export type CrossCheck =
  /** Both pairs agree; resumption proceeds by step 4. */
  | { readonly kind: 'agreed' }
  /**
   * The marker names no tour and no job, so there is nothing to compare.
   *
   * A pair with nothing on the marker's side is not two records disagreeing.
   * This is the ordinary shape of `IDLE` and of `PLANNING`, where the
   * identifier is not minted until the block is written (§4.1 step 7, D-45),
   * and stopping there would break the adoption path D-49 depends on.
   */
  | { readonly kind: 'no-tour' }
  | { readonly kind: 'disagreed'; readonly disagreements: readonly Disagreement[] }
  /**
   * The marker names a tour and the block cannot be read.
   *
   * Neither record can be trusted and there is no rule for choosing, which is
   * the same answer a disagreement gets.
   */
  | { readonly kind: 'unreadable-block'; readonly field: string; readonly problem: string };

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

/**
 * Compares the two pairs.
 *
 * Both sides are records, so nothing here corrects one from the other. What is
 * evidence sits one level down and is used where it exists: a job's acceptance
 * criterion for the job (D-65) and `.git` for a commit (step 2).
 */
export function crossCheckOpenTour(marker: StateMarker, read: OpenTourRead): CrossCheck {
  if (marker.tourId === null && marker.jobIndex === null) return { kind: 'no-tour' };

  if (read.kind === 'malformed') {
    return { kind: 'unreadable-block', field: read.field, problem: read.problem };
  }

  const disagreements: Disagreement[] = [];

  if (read.kind === 'none') {
    // A marker naming a tour against a section that states no tour is open is
    // a disagreement and not an absence: the block says so in words (SRS §3.5),
    // which is a reading rather than a gap.
    disagreements.push({
      pair: 'tour_id',
      marker: render(marker.tourId),
      block: 'no tour is open',
    });
    if (marker.jobIndex !== null) {
      disagreements.push({
        pair: 'job_index',
        marker: render(marker.jobIndex),
        block: 'no tour is open, so no row',
      });
    }
    return { kind: 'disagreed', disagreements };
  }

  if (marker.tourId !== read.block.tourId) {
    disagreements.push({
      pair: 'tour_id',
      marker: render(marker.tourId),
      block: read.block.tourId,
    });
  }

  const unfinished = firstUnfinishedRow(read);
  if (marker.jobIndex !== unfinished) {
    disagreements.push({
      pair: 'job_index',
      marker: render(marker.jobIndex),
      block: `${unfinished} (the first row not marked done)`,
    });
  }

  return disagreements.length === 0 ? { kind: 'agreed' } : { kind: 'disagreed', disagreements };
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
