import type { Options, SDKResultMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProjectConfig } from '../config/schema.js';
import { createPreviewBuilder, roleInState } from '../gates/build-preview.js';
import type { Notifier } from '../gates/notify.js';
import { type QueryFn, assembleSession } from '../roles/assembly.js';
import { createGateInterceptor } from '../roles/intercept.js';
import type { RoleName } from '../roles/schema.js';
import { createPermissionSupplier } from '../roles/supplier.js';
import { type StateMarker, type TourState, readMarker } from '../state/marker.js';
import { UsageMeter } from '../usage/meter.js';
import type { VerifyRunner } from '../verify/run.js';
import { type ConsumedSession, consumeSession, runSession } from './session.js';

/**
 * Sessions the drivers can run (SDD §4.2, §3.2, D-99, D-85).
 *
 * The drivers took an injected interface, which is what let them be exercised
 * without an account; what they never had was the thing that builds one. This
 * module is that: it assembles a role session, opens it through the one SDK
 * seam, drives it turn by turn, and meters what it spends.
 *
 * **A session belongs to one entry into one state (D-99).** The factory below
 * has one opener per state and nothing that reuses a session across two, so a
 * retry after `FAILED` opens a second Implementer session rather than sending
 * another turn to the first. Two mechanisms already assumed this and neither
 * said it: NFR-4 attributes usage by state, which is only well defined if a
 * session sits inside one, and D-61's authorization exists because the session
 * that raised a gate does not survive a park.
 *
 * **The SDK sits behind one seam (D-85).** `query` is a parameter all the way
 * down, so no path reaches the live API by forgetting to override a default,
 * and the tests above this line run everything except the API call itself.
 */

/** One turn's answer: the text the session produced, or null where it failed. */
export interface TurnResult {
  readonly text: string | null;
  readonly failed: boolean;
}

/**
 * A session being driven turn by turn over one `query` call.
 *
 * The SDK's streaming input is an async iterable the caller produces, so a
 * turn is a message pushed onto a queue and a result message read back off the
 * stream. The consumer runs to completion in the background, because a session
 * ends when the generator completes and nothing else marks it (A.4); `close`
 * is what lets it complete.
 */
class DrivenSession {
  private readonly pending: SDKUserMessage[] = [];
  private waiting: ((message: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  /** Resolves the turn in flight, set before each message is pushed. */
  private turnDone: ((result: SDKResultMessage) => void) | null = null;
  private consumed: Promise<ConsumedSession> | null = null;
  private lastText: string | null = null;
  private failed = false;

  constructor(
    private readonly start: (prompt: AsyncIterable<SDKUserMessage>) => Promise<ConsumedSession>,
  ) {}

  private input(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            const next = self.pending.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (self.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              self.waiting = resolve;
            });
          },
        };
      },
    };
  }

  /** Opens the session on first use, so a session nobody drove is never opened. */
  private open(): void {
    if (this.consumed !== null) return;
    this.consumed = this.start(this.input());
  }

  private push(text: string): void {
    const message = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage;

    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  /** Called by the consumer at every result message, which is a turn boundary. */
  onTurn(result: SDKResultMessage): void {
    const done = this.turnDone;
    this.turnDone = null;
    done?.(result);
  }

  /**
   * Sends one turn and resolves when it comes back.
   *
   * A session that has already ended answers without sending anything: the
   * generator has completed, so there is nowhere to send it, and pushing onto
   * a closed queue would hang the loop rather than report the failure.
   */
  async turn(text: string): Promise<TurnResult> {
    this.open();
    if (this.failed) return { text: null, failed: true };

    const arrived = new Promise<SDKResultMessage>((resolve) => {
      this.turnDone = resolve;
    });
    this.push(text);

    // Whichever comes first: the turn's result, or the whole session ending.
    // A session that ends without answering is a failure, not a wait.
    const ended = (this.consumed as Promise<ConsumedSession>).then(() => null);
    const result = await Promise.race([arrived, ended]);
    if (result === null) {
      const outcome = await (this.consumed as Promise<ConsumedSession>);
      this.failed = true;
      this.lastText = outcome.text;
      return { text: outcome.text, failed: true };
    }

    this.lastText = result.subtype === 'success' ? result.result : null;
    return { text: this.lastText, failed: result.subtype !== 'success' };
  }

  /** Closes the input so the generator can complete, and waits for the consumer. */
  async close(): Promise<ConsumedSession> {
    if (this.consumed === null) {
      return { text: this.lastText, errors: [], failed: false };
    }
    this.closed = true;
    const waiting = this.waiting;
    if (waiting !== null) {
      this.waiting = null;
      waiting({ value: undefined, done: true });
    }
    return await this.consumed;
  }
}

/**
 * The marker as it stands on disk (SDD §3.3, D-47).
 *
 * The interceptor asks for the marker at the moment of a call, and the
 * orchestrator writes it at every transition, so the file is current by
 * construction and is the record besides. Offered here rather than left to
 * each caller to reinvent, and it throws rather than inventing a state:
 * a marker nobody can read is what §4.4 step 1 exists for, and the middle of a
 * tool call is not where that is decided.
 */
export function markerOnDisk(root: string): StateMarker {
  const read = readMarker(root);
  if (read.kind !== 'ok') {
    throw new Error(
      `the state marker is ${read.kind}, so the orchestrator cannot say where it is. A gate raised without that would name no tour and no job (SDD §3.3, §4.4 step 1).`,
    );
  }
  return read.marker;
}

export interface SessionWiringInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The one SDK seam (D-85). Required, so nothing reaches the API by default. */
  readonly query: QueryFn;
  /** The marker as the orchestrator currently holds it (SDD §3.3, D-47). */
  readonly marker: () => StateMarker;
  readonly runVerification?: VerifyRunner;
  readonly notify?: Notifier;
  readonly now?: () => Date;
}

/** A session opened for one entry into one state, and the way to end it. */
export interface ScopedSession<T> {
  readonly session: T;
  /** Ends the session, which is what lets the generator complete (A.4). */
  readonly close: () => Promise<ConsumedSession>;
}

/**
 * Builds the `PreToolUse` hook and the `canUseTool` supplier once, and opens
 * assembled sessions against them.
 *
 * One interceptor serves both roles, so neither is intercepted less than the
 * other (D-43). What it needs to know about the caller it reads off the
 * marker, which names the state and therefore the role (D-99, `roleInState`).
 */
export function createSessionWiring(input: SessionWiringInput) {
  const now = input.now ?? (() => new Date());
  const interceptor = createGateInterceptor({
    root: input.root,
    config: input.config,
    marker: input.marker,
    buildPreview: createPreviewBuilder({
      root: input.root,
      config: input.config,
      marker: input.marker,
    }),
    ...(input.runVerification === undefined ? {} : { runVerification: input.runVerification }),
    ...(input.notify === undefined ? {} : { notify: input.notify }),
    now,
  });

  const hooks: Options['hooks'] = { PreToolUse: [{ hooks: [interceptor.hook] }] };
  const canUseTool = createPermissionSupplier({ root: input.root });

  /**
   * Opens one session for one state.
   *
   * The meter is built here rather than by the caller, because NFR-4 attributes
   * usage by role and by state and both are known exactly here: the state is
   * the entry being opened and the role is the one that holds it.
   */
  function openFor(
    role: RoleName,
    state: TourState,
    tourId: string | null,
    artifact: 'report' | 'none',
  ): { driven: DrivenSession; meter: UsageMeter } {
    const meter = new UsageMeter({ root: input.root, role, tourId, now });
    const driven: DrivenSession = new DrivenSession((prompt) => {
      const assembled = assembleSession({
        role,
        config: input.config,
        root: input.root,
        hooks,
        canUseTool,
        query: input.query,
      });
      const stream = assembled.open(prompt);
      const consume = {
        root: input.root,
        stream,
        meter,
        state,
        onTurn: (result: SDKResultMessage) => driven.onTurn(result),
        now,
      };
      // The report is the Implementer's alone (§4.2, D-82). A PM session
      // writing one would write it to the Implementer's path, over the report
      // closure is about to read.
      return artifact === 'report' && tourId !== null
        ? runSession({ ...consume, tourId }).then((run) => ({
            text: run.text,
            errors: run.errors,
            failed: run.failed,
          }))
        : consumeSession(consume);
    });
    return { driven, meter };
  }

  return { interceptor, hooks, canUseTool, openFor };
}

export type SessionWiring = ReturnType<typeof createSessionWiring>;
