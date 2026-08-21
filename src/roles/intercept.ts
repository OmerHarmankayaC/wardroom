import type {
  HookCallback,
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { type Duration, formatDuration } from '../config/duration.js';
import { ensureRunDir } from '../config/paths.js';
import type { ProjectConfig } from '../config/schema.js';
import { type ToolCallClassification, classifyToolCall } from '../gates/classify.js';
import { type Notifier, deliver, parkedNotification } from '../gates/notify.js';
import { enqueue, park, show } from '../gates/queue.js';
import type { GateEntry, GatePreview } from '../gates/schema.js';
import { headCommit } from '../state/git.js';
import { type StateMarker, type TourState, writeMarker } from '../state/marker.js';

/**
 * Gate interception as a `PreToolUse` hook (SDD §4.2, BACKLOG D-43).
 *
 * The hook is the only placement that cannot be switched off from elsewhere in
 * the configuration: it runs before the deny rules, the ask rules, the
 * permission mode, the allow rules and `canUseTool`, and its denial holds even
 * in `bypassPermissions` (Appendix A.2). Under the `canUseTool` design this
 * replaces, a call auto-approved at any earlier step never reached the gate at
 * all, and the gate reported nothing, because it was never asked.
 *
 * A hook answering `allow` does not skip the deny and ask rules below it
 * (Appendix A.2). The owner's approval releases a call into the rest of the
 * permission chain; it does not carry it past the chain.
 */

/** How long to wait between reads of the entry file while a gate is pending. */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface GateInterceptorInput {
  /** The repository Wardroom manages. */
  readonly root: string;
  readonly config: ProjectConfig;
  readonly tourId: string;
  readonly jobIndex: number | null;
  /** The state the tour returns to once the gate is decided (SDD §3.2). */
  readonly interruptedState: TourState;
  /**
   * Builds the class-mandated preview from what the call said.
   *
   * Injected rather than built here because a preview needs what the
   * classifier does not have: a push preview needs the commit list, which needs
   * the repository, and a deployment preview needs the pending migrations,
   * which need the project. The orchestrator holds both.
   */
  readonly buildPreview: (classification: ToolCallClassification) => GatePreview;
  /** Failed verification attempts so far, carried into the marker (FR-1.3). */
  readonly attemptCount?: number;
  /** Where the FR-3.3 notification goes. Absent is a surface that cannot be reached. */
  readonly notify?: Notifier;
  readonly pollIntervalMs?: number;
  /** Injected by tests so a wait is a yield rather than a real second. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

/**
 * What became of the run (SDD §3.2, FR-3.3).
 *
 * `parked` is an ordinary ending, not a failure: with one project per process
 * there is no other work to release the orchestrator to, so parking is a clean
 * exit. The run terminates with a non-error status, the gate keeps waiting, and
 * the next run finds `PARKED` and resumes on the owner's decision.
 */
export type InterceptionOutcome =
  | { readonly kind: 'running' }
  | {
      readonly kind: 'parked';
      readonly gateId: string;
      readonly interruptedState: TourState;
      readonly parkedAt: string;
      readonly notified: boolean;
    };

/**
 * Whether the run ended badly. Stated here rather than at each caller, so the
 * fact that parking is not an error has one home and the loop that will read it
 * cannot decide otherwise (SDD §3.2).
 */
export function isErrorOutcome(_outcome: InterceptionOutcome): boolean {
  return false;
}

export interface GateInterceptor {
  /** Install as `options.hooks.PreToolUse`. */
  readonly hook: HookCallback;
  /** What became of the run so far. */
  readonly outcome: () => InterceptionOutcome;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The hook's answer for a decided entry.
 *
 * Exported because it is the whole of what makes the hook a gate: the answer is
 * read off the entry rather than assumed, and a test runs this against a mutant
 * that answers `allow` regardless to show the assertion discriminates.
 *
 * A pending entry is a programming error here, not a decision. Answering
 * anything for one would be answering on the owner's behalf, so it throws.
 */
export function decisionOutcome(entry: GateEntry): SyncHookJSONOutput {
  if (entry.status === 'pending') {
    throw new Error(
      'decisionOutcome was asked for an entry nobody has decided; a gate is resolved by the owner, never by being read.',
    );
  }

  const by = entry.decidedBy ?? 'the owner';
  const note = entry.decisionNote === null ? '' : `: ${entry.decisionNote}`;

  if (entry.status === 'approved') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `Approved by ${by}${note}`,
      },
    };
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Rejected by ${by}${note}`,
    },
  };
}

/**
 * When a pending gate's waiting period runs out (FR-3.3).
 *
 * Measured from `requested_at` on the entry, which is the record, rather than
 * from when this process started waiting. A run that died and came back would
 * otherwise hand the same gate a fresh waiting period every restart, and a gate
 * that restarts often enough never parks at all.
 */
export function parkingDeadline(entry: GateEntry, gateWait: Duration): number {
  return new Date(entry.requestedAt).getTime() + gateWait.milliseconds;
}

/** Nothing to decide: the call is not gate-classified and is not touched. */
const UNTOUCHED: SyncHookJSONOutput = {};

/**
 * The answer for a gate that could not be raised or could not be read.
 *
 * Denying is the only safe answer available. Approving would let the action
 * through on the strength of a mechanism that has just demonstrated it is not
 * working, and passing the call through untouched would do the same more
 * quietly.
 */
function refusal(classification: ToolCallClassification, error: unknown): SyncHookJSONOutput {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `This is a ${classification.gateClass} gate and it could not be put to the owner: ${reason}. The action is denied rather than taken, because a gate nobody answered is not an approval.`,
    },
  };
}

/**
 * Builds the `PreToolUse` hook the role sessions run under.
 *
 * The same interceptor is installed on both roles. A role intercepted less than
 * the other is a role through which the gate can be walked around, and which
 * role that is would then depend on which one the model happened to be.
 */
export function createGateInterceptor(input: GateInterceptorInput): GateInterceptor {
  const sleep = input.sleep ?? realSleep;
  const now = input.now ?? (() => new Date());
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let outcome: InterceptionOutcome = { kind: 'running' };

  /** Waits for the owner, or for the waiting period to elapse. */
  async function waitForDecision(
    gateId: string,
  ): Promise<{ decided: GateEntry } | { elapsed: true }> {
    for (;;) {
      // Re-read from disk rather than from anything held in memory: the owner
      // decides against the entry file, from a surface this process does not
      // share (SDD §5.1, D-29).
      const entry = show(input.root, gateId);
      if (entry.status !== 'pending') return { decided: entry };
      if (now().getTime() >= parkingDeadline(entry, input.config.gateWait)) {
        return { elapsed: true };
      }
      await sleep(pollIntervalMs);
    }
  }

  /**
   * FR-3.3, in the order that survives a crash between any two steps.
   *
   * The entry is stamped first, because it is the record and the audit line
   * goes with it. The marker follows so a run that dies here still finds
   * `PARKED` next time. The notification is last and is allowed to fail: it is
   * the one step that changes nothing on disk.
   */
  function parkTour(gateId: string): SyncHookJSONOutput {
    const parked = park(input.root, gateId, { now: now() });

    // The outcome is set here, before the two steps that can still fail. The
    // tour parked the moment the entry was stamped, and a marker write or a
    // notifier that goes wrong afterwards must not erase the fact that it did.
    outcome = {
      kind: 'parked',
      gateId,
      interruptedState: input.interruptedState,
      parkedAt: parked.parkedAt ?? now().toISOString(),
      notified: false,
    };

    ensureRunDir(input.root);
    const marker: StateMarker = {
      state: 'PARKED',
      tourId: input.tourId,
      jobIndex: input.jobIndex,
      interruptedState: input.interruptedState,
      attemptCount: input.attemptCount ?? 0,
      // The marker names the gate it waits on (§3.3, D-62); parking decides
      // nothing, so the identifier travels with the state rather than being
      // cleared by it.
      gateId,
      headCommit: headCommit(input.root),
      updatedAt: now().toISOString(),
    };
    writeMarker(input.root, marker);

    const notified = deliver(
      input.notify,
      parkedNotification(parked, formatDuration(input.config.gateWait)),
    );
    outcome = { ...outcome, notified } as InterceptionOutcome;

    return {
      continue: false,
      stopReason: `The tour was parked: gate ${gateId} went unanswered for ${formatDuration(input.config.gateWait)}.`,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'The waiting period elapsed and the tour was parked. The gate is still pending and is still yours to answer; parking releases the orchestrator, it never decides (SDD §3.2). The action did not happen.',
      },
    };
  }

  const hook: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return UNTOUCHED;
    const call = hookInput as PreToolUseHookInput;

    const classification = classifyToolCall(call.tool_name, call.tool_input);
    if (classification === null) return UNTOUCHED;

    // Fails closed. A gate the orchestrator could not raise reported nothing,
    // and a call that proceeds on that silence is precisely the failure the
    // gate exists to prevent: no entry, no audit line, no owner, and a push.
    // So anything that goes wrong between classifying the call and reading the
    // owner's answer denies the call and says what went wrong.
    const raisedAt = now();
    let entry: GateEntry;
    try {
      entry = enqueue(
        input.root,
        {
          gateClass: classification.gateClass,
          tourId: input.tourId,
          jobIndex: input.jobIndex,
          interruptedState: input.interruptedState,
          what: classification.what,
          why: classification.why,
          preview: input.buildPreview(classification),
        },
        { now: raisedAt },
      );
    } catch (error) {
      return refusal(classification, error);
    }

    try {
      const waited = await waitForDecision(entry.gateId);
      return 'decided' in waited ? decisionOutcome(waited.decided) : parkTour(entry.gateId);
    } catch (error) {
      return refusal(classification, error);
    }
  };

  return { hook, outcome: () => outcome };
}
