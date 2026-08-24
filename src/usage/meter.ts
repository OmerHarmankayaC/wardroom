import type { ModelUsage, SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TourState } from '../state/marker.js';
import { NO_TOKENS, type TokenTotals, type UsageLine, addTokens, appendUsage } from './record.js';

/**
 * The meter (SDD §3.0, NFR-4, D-74, D-80, D-84, D-86, D-87).
 *
 * One session spans many jobs, so usage is accumulated as the session's
 * messages arrive and attributed to the job currently open: a job line at each
 * boundary, a session line when the session ends. The session line is the
 * reconciliation, and where the two disagree the session total is the
 * authority and the difference is recorded rather than smoothed.
 *
 * Two reading rules are not optional, and neither is visible from the field
 * names, which is exactly why they live here rather than at each call site:
 *
 * - **Cumulative fields are read, never summed.** `modelUsage` and
 *   `total_cost_usd` carry the running total for the whole `query()` call, so
 *   the latest result is the answer and adding results together double counts
 *   every earlier turn (D-87, Appendix A.4).
 * - **Per-message accumulation deduplicates on `message.id`.** One API turn
 *   may emit several assistant messages sharing an identifier, and summing
 *   their usage counts that turn more than once (D-87).
 *
 * And one field choice: the session total is `modelUsage`, not `usage`. Both
 * are on the result and they differ by design rather than by error, `usage`
 * covering the main agent loop alone. NFR-4 asks what the tour spent, and a
 * total that omits subagents is not that (D-86).
 */

/** Both result members carry the totals, so a failed session still meters. */
type MeteredResult = Pick<SDKResultMessage, 'modelUsage' | 'total_cost_usd'>;

export interface UsageMeterInput {
  readonly root: string;
  readonly role: UsageLine['role'];
  readonly tourId: string | null;
  readonly now?: () => Date;
}

/** What a session line recorded, returned so a caller need not re-read it. */
export interface SessionTotals {
  readonly line: UsageLine;
  /**
   * The gap between the session total and what accumulation reached, or null
   * where no result arrived and there was nothing to compare against.
   */
  readonly auxiliary: TokenTotals | null;
}

function sumModelUsage(modelUsage: Record<string, ModelUsage>): TokenTotals {
  return Object.values(modelUsage).reduce<TokenTotals>(
    (running, entry) => ({
      input: running.input + entry.inputTokens,
      output: running.output + entry.outputTokens,
    }),
    NO_TOKENS,
  );
}

export class UsageMeter {
  private readonly input: UsageMeterInput;
  private readonly now: () => Date;

  /**
   * The message ids already counted, for the whole session and not per job.
   *
   * A turn does not end at a job boundary, so an id seen before one may arrive
   * again after it; forgetting ids at the boundary would count that turn once
   * per job it straddles.
   */
  private readonly countedMessages = new Set<string>();

  /** Accumulated since the last boundary, and over the whole session. */
  private jobTokens: TokenTotals = NO_TOKENS;
  private sessionTokens: TokenTotals = NO_TOKENS;

  /** The latest result, which carries the running totals. Never accumulated. */
  private latestResult: MeteredResult | null = null;
  /** The cumulative cost as it stood at the last boundary. */
  private costAtLastBoundary = 0;
  /** The session the messages came from, taken from the messages themselves. */
  private sessionId: string | null = null;

  constructor(input: UsageMeterInput) {
    this.input = input;
    this.now = input.now ?? (() => new Date());
  }

  /** Takes one message off the stream. Everything else here reads what this left. */
  observe(message: SDKMessage): void {
    const sessionId = (message as { session_id?: unknown }).session_id;
    if (typeof sessionId === 'string' && sessionId !== '') this.sessionId = sessionId;

    if (message.type === 'assistant') {
      const { id, usage } = message.message;
      // The deduplication. Not an optimization: several messages share one id
      // by design, and each carries that turn's usage rather than its own
      // share of it (Appendix A.4).
      if (this.countedMessages.has(id)) return;
      this.countedMessages.add(id);

      const counted = { input: usage.input_tokens, output: usage.output_tokens };
      this.jobTokens = addTokens(this.jobTokens, counted);
      this.sessionTokens = addTokens(this.sessionTokens, counted);
      return;
    }

    if (message.type === 'result') {
      // Replaced, never added to. This is the running total for the whole
      // call, so the latest one is the answer (D-87).
      this.latestResult = message;
    }
  }

  /**
   * Writes the line for the job that was open and starts the next one.
   *
   * The cost is what the cumulative counter moved by since the last boundary,
   * which is a reading of a cumulative field rather than a sum of results.
   * Absent where no result has arrived at all: a job that saw none did not
   * cost nothing, it was not measured, and the ceiling reader must be able to
   * tell the two apart (D-80).
   */
  boundary(state: TourState, jobIndex: number): UsageLine {
    const cost = this.latestResult?.total_cost_usd;
    const spent = cost === undefined ? undefined : cost - this.costAtLastBoundary;

    const line: UsageLine = {
      kind: 'job',
      ts: this.now().toISOString(),
      role: this.input.role,
      state,
      tourId: this.input.tourId,
      jobIndex,
      sessionId: this.sessionId,
      tokens: this.jobTokens,
      ...(spent === undefined ? {} : { usd: spent }),
    };
    appendUsage(this.input.root, line);

    this.jobTokens = NO_TOKENS;
    if (cost !== undefined) this.costAtLastBoundary = cost;
    return line;
  }

  /**
   * Writes the session line: the session total, with the gap to the
   * accumulated figure recorded as auxiliary (D-86).
   *
   * Where no result ever arrived there is no session total and no gap. The
   * line still carries the accumulated tokens, because those were measured;
   * the cost and the gap are absent rather than zero.
   */
  end(state: TourState): SessionTotals {
    const result = this.latestResult;
    const total = result === null ? null : sumModelUsage(result.modelUsage);

    // Signed, and not clamped. Accumulation above the authority is not
    // auxiliary usage, it is a disagreement, and clamping it to zero would
    // hide the one reading that says something is wrong.
    const auxiliary =
      total === null
        ? null
        : {
            input: total.input - this.sessionTokens.input,
            output: total.output - this.sessionTokens.output,
          };

    const line: UsageLine = {
      kind: 'session',
      ts: this.now().toISOString(),
      role: this.input.role,
      state,
      tourId: this.input.tourId,
      // A session line belongs to no single job: it is what the session spent,
      // and the job lines are where it is attributed.
      jobIndex: null,
      sessionId: this.sessionId,
      tokens: total ?? this.sessionTokens,
      ...(result === null ? {} : { usd: result.total_cost_usd }),
      ...(auxiliary === null ? {} : { auxiliary }),
    };
    appendUsage(this.input.root, line);
    return { line, auxiliary };
  }
}
