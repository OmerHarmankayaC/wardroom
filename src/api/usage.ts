import { loadConfig } from '../config/load.js';
import type { UsageBudget } from '../config/schema.js';
import { type CeilingVerdict, ceilingAgainst } from '../loop/ceiling.js';
import { type UsageLine, type UsageSummary, readUsage, usageSummary } from '../usage/record.js';

/**
 * The attributed token and cost breakdown (SDD §5.1, NFR-4).
 *
 * NFR-4 asks for attribution and not a bare total: what a tour spent, by role
 * and by the state it was spent in. A single number cannot answer the question
 * the requirement exists for, which is where the spending went, and the record
 * carries the axes precisely so that this does not have to guess.
 *
 * Nothing is summed that the record says is cumulative (D-87) and nothing is
 * inferred where the meter did not run (D-46, D-80): a tour with no cost lines
 * is reported as not measured, never as free.
 */

/** One axis of the breakdown, and what it accounts for. */
export interface UsageBucket {
  readonly key: string;
  readonly lines: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Null where no line in the bucket carried a cost (D-46, D-80). */
  readonly usd: number | null;
}

export interface UsageReport {
  /** The tour asked about, or null for the lines that precede any tour record. */
  readonly tourId: string | null;
  readonly summary: UsageSummary;
  readonly budget: CeilingVerdict;
  readonly byRole: readonly UsageBucket[];
  readonly byState: readonly UsageBucket[];
  readonly byJob: readonly UsageBucket[];
  /** Every line the report was built from, oldest first, so a surface can show the record. */
  readonly lines: readonly UsageLine[];
}

/**
 * Buckets the job lines on one axis.
 *
 * Job lines only. A session line is the same spending seen whole (D-84), and
 * adding it to the job lines it reconciles counts every job twice, so a
 * breakdown that mixed the two would report roughly double what the summary
 * beside it reports, from the same file, in the same answer.
 */
function bucket(lines: readonly UsageLine[], keyOf: (line: UsageLine) => string): UsageBucket[] {
  const buckets = new Map<
    string,
    { lines: number; input: number; output: number; usd: number | null }
  >();
  for (const line of lines) {
    const key = keyOf(line);
    const running = buckets.get(key) ?? { lines: 0, input: 0, output: 0, usd: null };
    buckets.set(key, {
      lines: running.lines + 1,
      input: running.input + line.tokens.input,
      output: running.output + line.tokens.output,
      // Null plus a cost is that cost; null and no cost stays null, which is
      // how a bucket nothing metered stays distinguishable from a free one.
      usd: line.usd === undefined ? running.usd : (running.usd ?? 0) + line.usd,
    });
  }
  return [...buckets.entries()].map(([key, totals]) => ({
    key,
    lines: totals.lines,
    inputTokens: totals.input,
    outputTokens: totals.output,
    usd: totals.usd,
  }));
}

export interface UsageReportInput {
  /** The tour to report on. Omitted, the tour the record's last line names. */
  readonly tourId?: string | null;
  /** The ceiling to compare against. Omitted, the project contract's. */
  readonly ceiling?: UsageBudget;
}

/**
 * The tour the record last spent anything on.
 *
 * `usage.report(path)` with no tour is a question about the project, and the
 * only honest answer from files alone is the most recent tour that spent
 * something. Reading the marker instead would answer null for every project
 * sitting at `IDLE`, which is most of them most of the time.
 */
function latestTour(lines: readonly UsageLine[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const tourId = lines[index]?.tourId;
    if (tourId != null) return tourId;
  }
  return null;
}

export function usageReport(root: string, input: UsageReportInput = {}): UsageReport {
  const config = loadConfig(root);
  const all = readUsage(root);
  const tourId = input.tourId === undefined ? latestTour(all) : input.tourId;
  const lines = all.filter((line) => line.tourId === tourId);
  const jobs = lines.filter((line) => line.kind === 'job');
  const summary = usageSummary(root, { tourId, authMode: config.authMode });

  return {
    tourId,
    summary,
    budget: ceilingAgainst(summary, (input.ceiling ?? config.usageBudget).usd),
    byRole: bucket(jobs, (line) => line.role),
    byState: bucket(jobs, (line) => line.state),
    byJob: bucket(jobs, (line) => (line.jobIndex === null ? 'none' : String(line.jobIndex))),
    lines,
  };
}
