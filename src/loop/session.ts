import { mkdirSync } from 'node:fs';
import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { wardroomPaths } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';
import type { TourState } from '../state/marker.js';
import { reportPath } from '../state/report.js';
import type { UsageMeter } from '../usage/meter.js';

/**
 * Consuming one session's stream (SDD §4.2, §4.6, Appendix A.4, D-73, D-82,
 * D-88).
 *
 * **A session ends when the generator completes, and nothing else marks it.**
 * A result message is a turn boundary: in a streaming-input session one
 * arrives per turn, each carrying the running totals so far. A consumer that
 * wrote the report at the first result would write the first turn's text and
 * stop reading, and would meter one turn as though it were the session.
 *
 * So the stream is read to completion, the latest result is kept, and the
 * report is written once at the end. The report lives on disk rather than in
 * this process because §4.4's `CLOSING` branch has to survive a death: a
 * report that lives only in a session transcript is gone the moment the
 * process is, and the document debts it carries go with it.
 *
 * **An error result carries no report at all (D-88).** The report text lives
 * on the success member and the error member has no such field, only its
 * errors. That is not a report with a part missing (D-82) but the absence of
 * the artifact, and the two are handled differently: the errors are written to
 * the report path as an aborted record, so the failure is durable, and the
 * session is reported as failed rather than as a finished job list.
 */

/** How an aborted record announces itself, so a report reader cannot take it for one. */
export const ABORTED_HEADING = '# Session aborted';

/** A session that did not complete, raised where a caller must not carry on. */
export class SessionAbortedError extends Error {
  readonly tourId: string;
  readonly errors: readonly string[];

  constructor(tourId: string, errors: readonly string[]) {
    super(
      `the session for ${tourId} ended without a report: ${errors.join('; ')}. It is treated as failed rather than as a finished job list, so nothing exits to VERIFYING and resumption starts from the first job whose criterion does not pass (SDD §4.2, §4.6, D-88).`,
    );
    this.name = 'SessionAbortedError';
    this.tourId = tourId;
    this.errors = errors;
  }
}

export interface RunSessionInput {
  readonly root: string;
  readonly tourId: string;
  readonly stream: AsyncIterable<SDKMessage>;
  /** Fed every message as it arrives. Absent where the session is not metered. */
  readonly meter?: UsageMeter;
  /**
   * The state the session ran in, which the session line is attributed to.
   *
   * Required, and deliberately without a default. NFR-4 attributes usage by
   * state, and a default would file a PM planning session's spending under
   * whichever state was written here as the common case. That is not a missing
   * value the caller forgot, it is one only the caller knows.
   */
  readonly state: TourState;
  readonly now?: () => Date;
}

export interface SessionRunResult {
  readonly kind: 'reported' | 'aborted';
  /** True for an aborted session, in the words §4.2 uses. */
  readonly failed: boolean;
  /** The report text as written, or null where the session aborted. */
  readonly text: string | null;
  /** The errors an aborted session carried. Empty for a reported one. */
  readonly errors: readonly string[];
  readonly path: string;
  /** Raises {@link SessionAbortedError} where the session did not complete. */
  readonly assertCompleted: () => void;
}

type SuccessResult = Extract<SDKResultMessage, { subtype: 'success' }>;

/**
 * The errors a result carries, empty where it carries a report instead.
 *
 * The subtype is narrowed inline rather than through a helper predicate. A
 * predicate reading "carries a report" would tell the compiler that anything
 * it rejects is the error member, and that is false: a `success` result with
 * `is_error` true is rejected here and is still the success member. Narrowing
 * on a claim that does not hold is how the error text on that member becomes
 * unreachable code.
 */
function errorsFrom(result: SDKResultMessage | null): string[] {
  if (result === null) {
    return [
      'the stream ended with no result message at all, so the session produced neither a report nor a reason',
    ];
  }
  if (result.subtype === 'success') {
    // With `is_error` true this member carries the error text in `result`,
    // which is the one place it is carried (A.4).
    return result.is_error ? [result.result] : [];
  }
  return [...result.errors];
}

function abortedRecord(tourId: string, errors: readonly string[], at: string): string {
  return [
    ABORTED_HEADING,
    '',
    `- **Tour:** ${tourId}`,
    `- **At:** ${at}`,
    '',
    'The session ended without producing a report. This is the absence of the',
    'artifact rather than a report with a part missing, so it is recorded here',
    'as what happened and is deliberately not readable as a report (D-88).',
    '',
    '## Errors',
    '',
    ...errors.map((error) => `- ${error}`),
    '',
  ].join('\n');
}

/**
 * Reads one session's stream to the end, writing what it produced to the
 * report path.
 *
 * Nothing is written before the generator completes, because nothing before
 * then is the session's last message.
 */
export async function runSession(input: RunSessionInput): Promise<SessionRunResult> {
  const now = input.now ?? (() => new Date());
  let latestResult: SDKResultMessage | null = null;

  for await (const message of input.stream) {
    input.meter?.observe(message);
    // Replaced rather than kept: the last one is the session's, and the
    // earlier ones were turns.
    if (message.type === 'result') latestResult = message;
  }

  // The session line belongs to the session's end, which is here.
  input.meter?.end(input.state);

  const errors = errorsFrom(latestResult);
  const path = reportPath(input.root, input.tourId);
  mkdirSync(wardroomPaths(input.root).reportsDir, { recursive: true });

  if (errors.length > 0) {
    atomicWriteFile(path, abortedRecord(input.tourId, errors, now().toISOString()));
    return {
      kind: 'aborted',
      failed: true,
      text: null,
      errors,
      path,
      assertCompleted: () => {
        throw new SessionAbortedError(input.tourId, errors);
      },
    };
  }

  // Written verbatim. The report is a record of what the session said, and
  // §4.6 checks its claims rather than adopting them, so nothing here edits,
  // completes or validates it: a consumer that repaired the text would be
  // checking a report it had helped write.
  const text = (latestResult as SuccessResult).result;
  atomicWriteFile(path, text);
  return {
    kind: 'reported',
    failed: false,
    text,
    errors: [],
    path,
    assertCompleted: () => undefined,
  };
}
