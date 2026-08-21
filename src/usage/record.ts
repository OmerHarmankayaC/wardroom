import { wardroomPaths } from '../config/paths.js';
import type { AuthMode } from '../config/schema.js';
import { appendJsonLine, readJsonLines } from '../fs/jsonl.js';
import type { TourState } from '../state/marker.js';

/**
 * The usage record (SDD §3.0, SRS NFR-4, BACKLOG D-74).
 *
 * `.wardroom/run/usage.jsonl`, append-only, one line per session with the axes
 * the measurement is attributed along. Two things already depend on it:
 * `usage.report` (§5.1) reads it, and FR-1.4's boundary decision needs the
 * cost spent so far and the largest single job's cost in the current tour,
 * neither of which is recoverable from a process that has exited.
 *
 * It is appended rather than replaced, for the same reason the audit log is:
 * a record of what happened is not a record of what is currently true, and
 * replacing a whole file is the one thing an append-only log must never do.
 */

/**
 * NFR-4's read categories. Optional on a line because nothing measures them
 * yet, and present as a field because the requirement names the axis as a
 * minimum: a record with no place to put it could not satisfy NFR-4 however
 * carefully it was filled in.
 */
export const READ_CATEGORIES = [
  'canonical-documents',
  'project-history',
  'external-documentation',
  'code-exploration',
  'generated-output',
] as const;
export type ReadCategory = (typeof READ_CATEGORIES)[number];

export interface TokenTotals {
  readonly input: number;
  readonly output: number;
}

export interface UsageLine {
  readonly ts: string;
  /** Which role spent it (NFR-4). */
  readonly role: 'pm' | 'implementer';
  /** Which state it was spent in (NFR-4, SDD §3.2). */
  readonly state: TourState;
  /** Null where the session preceded the tour record (D-45, D-70). */
  readonly tourId: string | null;
  /** Null for a session that belongs to no single job, such as planning. */
  readonly jobIndex: number | null;
  readonly tokens: TokenTotals;
  /** Absent where the meter is inactive (D-46). Never zero standing in for it. */
  readonly usd?: number;
  readonly readCategory?: ReadCategory;
}

interface OnDiskLine {
  ts: string;
  role: string;
  state: string;
  tour_id: string | null;
  job_index: number | null;
  tokens: TokenTotals;
  usd?: number;
  read_category?: string;
}

/** Appends one line. Never reads, never rewrites, never truncates. */
export function appendUsage(root: string, line: UsageLine): void {
  const onDisk: OnDiskLine = {
    ts: line.ts,
    role: line.role,
    state: line.state,
    tour_id: line.tourId,
    job_index: line.jobIndex,
    tokens: line.tokens,
    // Spread rather than assigned: an absent cost and a cost of zero are
    // different facts, and `usd: undefined` would serialize to neither.
    ...(line.usd === undefined ? {} : { usd: line.usd }),
    ...(line.readCategory === undefined ? {} : { read_category: line.readCategory }),
  };
  appendJsonLine(wardroomPaths(root).usageLog, onDisk);
}

/**
 * Every line, oldest first.
 *
 * A trailing partial line is ignored rather than raised, as in the audit log:
 * a process killed mid-append leaves one, and refusing to read the record
 * because of its last few bytes loses the evidence it exists to keep.
 */
export function readUsage(root: string): UsageLine[] {
  return readJsonLines(wardroomPaths(root).usageLog).map((raw) => {
    const record = raw as OnDiskLine;
    return {
      ts: record.ts,
      role: record.role as UsageLine['role'],
      state: record.state as TourState,
      tourId: record.tour_id,
      jobIndex: record.job_index,
      tokens: record.tokens,
      ...(record.usd === undefined ? {} : { usd: record.usd }),
      ...(record.read_category === undefined
        ? {}
        : { readCategory: record.read_category as ReadCategory }),
    } as UsageLine;
  });
}

/**
 * What the tour has spent, in the two numbers the ceiling check reads (D-66).
 *
 * `inactive` is a third answer and not a zero. Reporting a cost of zero for an
 * unmetered tour would tell the owner the tour was free; it was not measured,
 * which is a different fact and the one D-46 insists on. The token totals are
 * reported either way, because the meter being inactive does not touch them.
 */
export type UsageSummary =
  | {
      readonly kind: 'inactive';
      readonly reason: string;
      readonly tokens: TokenTotals;
    }
  | {
      readonly kind: 'measured';
      readonly spentUsd: number;
      /** The largest single job's cost so far, summed over the sessions it spans. */
      readonly largestJobUsd: number;
      /** How many jobs contributed, so a caller can tell one job from none. */
      readonly jobsMeasured: number;
      readonly tokens: TokenTotals;
    };

export interface UsageQuery {
  /** The tour being asked about. Null asks about the sessions before any tour. */
  readonly tourId: string | null;
  readonly authMode: AuthMode;
}

function totalTokens(lines: readonly UsageLine[]): TokenTotals {
  return lines.reduce(
    (running, line) => ({
      input: running.input + line.tokens.input,
      output: running.output + line.tokens.output,
    }),
    { input: 0, output: 0 },
  );
}

/** Answers the ceiling check for one tour. */
export function usageSummary(root: string, query: UsageQuery): UsageSummary {
  const lines = readUsage(root).filter((line) => line.tourId === query.tourId);
  const tokens = totalTokens(lines);

  if (query.authMode === 'subscription') {
    return {
      kind: 'inactive',
      reason:
        'auth_mode is subscription, where no dollar meter exists at all, so usage_budget has nothing to measure and is reported as inactive rather than satisfied (SRS §3.1, D-46).',
      tokens,
    };
  }

  const costed = lines.filter((line) => line.usd !== undefined);
  if (lines.length > 0 && costed.length === 0) {
    // Not a free tour: a meter that did not run. Answering zero here would let
    // the ceiling check pass on a number nobody measured.
    return {
      kind: 'inactive',
      reason:
        'the meter is configured but no line in this tour carries a cost, so there is nothing measured to compare against the ceiling.',
      tokens,
    };
  }

  const perJob = new Map<number, number>();
  for (const line of costed) {
    if (line.jobIndex === null) continue;
    perJob.set(line.jobIndex, (perJob.get(line.jobIndex) ?? 0) + (line.usd ?? 0));
  }

  return {
    kind: 'measured',
    spentUsd: costed.reduce((running, line) => running + (line.usd ?? 0), 0),
    largestJobUsd: perJob.size === 0 ? 0 : Math.max(...perJob.values()),
    jobsMeasured: perJob.size,
    tokens,
  };
}
