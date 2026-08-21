import type { ProjectConfig } from '../config/schema.js';
import { usageSummary } from '../usage/record.js';

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

/** Reads the usage record and answers whether the next job can be expected to fit. */
export function ceilingVerdict(
  root: string,
  config: ProjectConfig,
  tourId: string | null,
): CeilingVerdict {
  const summary = usageSummary(root, { tourId, authMode: config.authMode });
  if (summary.kind === 'inactive') return { kind: 'inactive', reason: summary.reason };

  const ceilingUsd = config.usageBudget.usd;
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
