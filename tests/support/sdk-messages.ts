import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * SDK messages, built to the shapes Appendix A.4 records.
 *
 * One home, because two suites need them and both were building their own.
 * They are not trivial fixtures: the cumulative fields, the shared
 * `message.id` and the two result members are exactly the properties the meter
 * and the session consumer are tested against, so two copies would be two
 * accounts of what the stream looks like, drifting toward whichever suite was
 * edited last. The rules this file encodes are the ones the field names do not
 * show (D-86, D-87).
 *
 * This file is not a suite: it lives outside the `*.test.ts` pattern the
 * runner collects.
 */

export const DEFAULT_SESSION = 'session-1';

/**
 * An assistant message carrying one turn's usage.
 *
 * Several messages may share an `id`, each carrying that turn's usage rather
 * than a share of it, which is why the id is a parameter and not generated.
 */
export function assistantMessage(
  id: string,
  input: number,
  output: number,
  sessionId: string = DEFAULT_SESSION,
): SDKMessage {
  return {
    type: 'assistant',
    session_id: sessionId,
    message: {
      id,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  } as unknown as SDKMessage;
}

export interface ResultOptions {
  /** The cumulative `modelUsage` totals so far, not this turn's alone. */
  readonly input?: number;
  readonly output?: number;
  readonly costUsd?: number;
  /** `usage`, the main-loop figure, where it differs from `modelUsage`. */
  readonly mainLoopInput?: number;
  /** The report text, on the success member only. */
  readonly text?: string;
  /** Produces the error member instead, which carries no report at all. */
  readonly errors?: readonly string[];
  /** The success member with `is_error`, whose `result` is the error text. */
  readonly isError?: boolean;
  readonly sessionId?: string;
}

/**
 * A result message: a turn boundary, not the session's end.
 *
 * `modelUsage` and `total_cost_usd` are cumulative across turns, so each
 * result carries the running total so far rather than that turn's alone. A
 * fixture that made them per-turn would let a consumer that sums results pass.
 */
export function resultMessage(options: ResultOptions = {}): SDKMessage {
  const input = options.input ?? 0;
  const output = options.output ?? 0;
  const costUsd = options.costUsd ?? 0;
  const session = options.sessionId ?? DEFAULT_SESSION;
  const totals = {
    total_cost_usd: costUsd,
    usage: {
      input_tokens: options.mainLoopInput ?? input,
      output_tokens: output,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {
      'claude-opus-5': {
        inputTokens: input,
        outputTokens: output,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: costUsd,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
  };

  if (options.errors !== undefined) {
    return {
      type: 'result',
      subtype: 'error_during_execution',
      session_id: session,
      is_error: true,
      errors: [...options.errors],
      ...totals,
    } as unknown as SDKMessage;
  }

  return {
    type: 'result',
    subtype: 'success',
    session_id: session,
    is_error: options.isError === true,
    result: options.text ?? 'a report',
    ...totals,
  } as unknown as SDKMessage;
}

/** The messages as a stream, which is what a session actually hands over. */
export function messageStream(...messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  return (async function* () {
    for (const message of messages) yield message;
  })();
}
