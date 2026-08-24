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

/**
 * The two lines §3.0 names, as data.
 *
 * A job line is what one job cost; a session line is what the session spent in
 * total, and it is the authority where the two disagree (D-84). They are kept
 * apart because a reader that added them together would count every job twice:
 * the session line is not another job, it is the same spending seen whole.
 */
export const USAGE_LINE_KINDS = ['job', 'session'] as const;
export type UsageLineKind = (typeof USAGE_LINE_KINDS)[number];

export interface UsageLine {
  readonly kind: UsageLineKind;
  readonly ts: string;
  /** Which role spent it (NFR-4). */
  readonly role: 'pm' | 'implementer';
  /** Which state it was spent in (NFR-4, SDD §3.2). */
  readonly state: TourState;
  /** Null where the session preceded the tour record (D-45, D-70). */
  readonly tourId: string | null;
  /** Null for a session that belongs to no single job, such as planning. */
  readonly jobIndex: number | null;
  /**
   * The SDK session that produced it, so a session line and the job lines it
   * reconciles are one group (D-84).
   *
   * Null where a line was written outside a session. Without it the reader
   * cannot tell which job lines a session line is the total of, and a tour
   * spanning two sessions (a retry out of `FAILED`) would have no way to add
   * the second to the first without double counting the first.
   */
  readonly sessionId: string | null;
  readonly tokens: TokenTotals;
  /** Absent where the meter is inactive (D-46). Never zero standing in for it. */
  readonly usd?: number;
  /**
   * Session lines only: the session total less what per-message accumulation
   * reached (D-86).
   *
   * Per-message accumulation sees the main agent loop only, so it normally
   * comes in under the session total, and the gap is auxiliary usage: subagent,
   * sidechain and internal calls. Recorded as auxiliary rather than reported as
   * drift, because a naive implementation reads it as a defect. Absent, not
   * zero, where no result ever arrived to compare against.
   */
  readonly auxiliary?: TokenTotals;
  readonly readCategory?: ReadCategory;
}

interface OnDiskLine {
  kind: string;
  ts: string;
  role: string;
  state: string;
  tour_id: string | null;
  job_index: number | null;
  session_id: string | null;
  tokens: TokenTotals;
  usd?: number;
  auxiliary?: TokenTotals;
  read_category?: string;
}

/** Appends one line. Never reads, never rewrites, never truncates. */
export function appendUsage(root: string, line: UsageLine): void {
  const onDisk: OnDiskLine = {
    kind: line.kind,
    ts: line.ts,
    role: line.role,
    state: line.state,
    tour_id: line.tourId,
    job_index: line.jobIndex,
    session_id: line.sessionId,
    tokens: line.tokens,
    // Spread rather than assigned: an absent cost and a cost of zero are
    // different facts, and `usd: undefined` would serialize to neither. The
    // same holds for the auxiliary gap, where absent means no result arrived
    // to compare against and zero means the two figures agreed.
    ...(line.usd === undefined ? {} : { usd: line.usd }),
    ...(line.auxiliary === undefined ? {} : { auxiliary: line.auxiliary }),
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
      // Anything that does not say `session` is a job line. A line whose kind
      // cannot be read must not become the authority over lines it never
      // reconciled, so the doubt resolves toward the narrower meaning.
      kind: record.kind === 'session' ? 'session' : 'job',
      ts: record.ts,
      role: record.role as UsageLine['role'],
      state: record.state as TourState,
      tourId: record.tour_id,
      jobIndex: record.job_index,
      sessionId: record.session_id ?? null,
      tokens: record.tokens,
      ...(record.usd === undefined ? {} : { usd: record.usd }),
      ...(record.auxiliary === undefined ? {} : { auxiliary: record.auxiliary }),
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

/**
 * What each session spent, with the session line as the authority (D-84).
 *
 * A session line is not another job: it is the same spending seen whole, and
 * adding it to the job lines it reconciles counts every job twice. So each
 * session contributes its session line where one exists, and the sum of its
 * job lines where the session is still running and has not written one yet.
 *
 * Where a session wrote more than one session line, the last wins. The record
 * is append-only, so an earlier line is an earlier reading of the same
 * cumulative figure, and reading the latest is the same rule the meter follows
 * against the SDK's own cumulative fields (D-87).
 */
interface SessionGroup {
  sessionUsd: number | null;
  jobsUsd: number;
  sessionTokens: TokenTotals | null;
  jobsTokens: TokenTotals;
}

/** A total that has counted nothing, which is not the same as one absent. */
export const NO_TOKENS: TokenTotals = { input: 0, output: 0 };

/** Adds two totals. Exported so the meter adds them the same way this does. */
export function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return { input: a.input + b.input, output: a.output + b.output };
}

/**
 * The lines grouped by the session that wrote them, with the session line as
 * that session's authority (D-84).
 *
 * A session line is not another job: it is the same spending seen whole, and
 * adding it to the job lines it reconciles counts every job twice. So each
 * session contributes its session line where one exists, and the sum of its
 * job lines where the session is still running and has not written one yet.
 *
 * Cost and tokens are grouped together rather than by two functions walking
 * the same lines with the same rule, because the rule is the fact here and it
 * belongs in one place.
 *
 * Where a session wrote more than one session line, the last wins. The record
 * is append-only, so an earlier line is an earlier reading of the same
 * cumulative figure, and reading the latest is the rule the meter already
 * follows against the SDK's own cumulative fields (D-87).
 */
function bySession(lines: readonly UsageLine[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const line of lines) {
    // Lines with no session form one group. They were written outside a
    // session, so nothing reconciles them and each is its own evidence.
    const key = line.sessionId ?? '';
    const group = groups.get(key) ?? {
      sessionUsd: null,
      jobsUsd: 0,
      sessionTokens: null,
      jobsTokens: NO_TOKENS,
    };
    if (line.kind === 'session') {
      if (line.usd !== undefined) group.sessionUsd = line.usd;
      group.sessionTokens = line.tokens;
    } else {
      if (line.usd !== undefined) group.jobsUsd += line.usd;
      group.jobsTokens = addTokens(group.jobsTokens, line.tokens);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function totalTokens(lines: readonly UsageLine[]): TokenTotals {
  return bySession(lines).reduce(
    (running, group) => addTokens(running, group.sessionTokens ?? group.jobsTokens),
    NO_TOKENS,
  );
}

function spentPerSession(lines: readonly UsageLine[]): number {
  return bySession(lines).reduce(
    (running, group) => running + (group.sessionUsd ?? group.jobsUsd),
    0,
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

  // Job lines only. A session line belongs to no single job, and letting one
  // through here would make the whole session look like the largest job and
  // end the tour a boundary early.
  const perJob = new Map<number, number>();
  for (const line of costed) {
    if (line.kind !== 'job' || line.jobIndex === null) continue;
    perJob.set(line.jobIndex, (perJob.get(line.jobIndex) ?? 0) + (line.usd ?? 0));
  }

  return {
    kind: 'measured',
    spentUsd: spentPerSession(costed),
    largestJobUsd: perJob.size === 0 ? 0 : Math.max(...perJob.values()),
    jobsMeasured: perJob.size,
    tokens,
  };
}
