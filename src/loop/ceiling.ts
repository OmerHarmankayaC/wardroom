import type { ProjectConfig } from '../config/schema.js';
import { type UsageSummary, usageSummary } from '../usage/record.js';

/**
 * The usage ceiling at a job boundary (SDD §3.2, SRS FR-1.4, BACKLOG D-66).
 *
 * "Cannot be expected to fit" is measured rather than guessed: the tour closes
 * at the first boundary where the cost already spent, plus the largest single
 * job's cost so far in this tour, reaches the ceiling. At the first boundary
 * the largest job so far is the job just finished, so the rule is defined from
 * job 1 and needs no second configuration field and no fraction nobody chose.
 *
 * The largest job rather than the last one, because a cheap final job would
 * otherwise let an expensive tour carry on into a budget it cannot afford.
 */

export type CeilingVerdict =
  | {
      /**
       * No meter, so no ceiling to check against (D-46). Kept apart from
       * `within` deliberately: a caller reading "not reached" as "within
       * budget" would be told a tour was affordable by a meter that never ran.
       */
      readonly kind: 'inactive';
      readonly reason: string;
    }
  | {
      readonly kind: 'within';
      readonly spentUsd: number;
      readonly largestJobUsd: number;
      readonly ceilingUsd: number;
    }
  | {
      readonly kind: 'reached';
      readonly spentUsd: number;
      readonly largestJobUsd: number;
      readonly ceilingUsd: number;
    };

/**
 * The comparison itself, over a summary somebody else read.
 *
 * Separated from the read so that a caller which already holds the summary,
 * `status` does (SDD §5.1), asks this rather than restating the arithmetic.
 * Two statements of the rule would be two places for the boundary to move, and
 * the surface reporting one answer while the drive acts on another is the
 * worst version of that.
 */
export function ceilingAgainst(summary: UsageSummary, ceilingUsd: number): CeilingVerdict {
  if (summary.kind === 'inactive') return { kind: 'inactive', reason: summary.reason };

  // Reaches, not exceeds. A rule waiting for strictly greater would let one
  // more job start on a budget already spent.
  const reached = summary.spentUsd + summary.largestJobUsd >= ceilingUsd;

  return {
    kind: reached ? 'reached' : 'within',
    spentUsd: summary.spentUsd,
    largestJobUsd: summary.largestJobUsd,
    ceilingUsd,
  };
}

/** Reads the usage record and answers whether the next job can be expected to fit. */
export function ceilingVerdict(
  root: string,
  config: ProjectConfig,
  tourId: string | null,
): CeilingVerdict {
  return ceilingAgainst(
    usageSummary(root, { tourId, authMode: config.authMode }),
    config.usageBudget.usd,
  );
}
