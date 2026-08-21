import type {
  HookCallback,
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProjectConfig } from '../config/schema.js';
import { type ToolCallClassification, classifyToolCall } from '../gates/classify.js';
import { enqueue, show } from '../gates/queue.js';
import type { GateEntry, GatePreview } from '../gates/schema.js';
import type { TourState } from '../state/marker.js';

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
  readonly pollIntervalMs?: number;
  /** Injected by tests so a wait is a yield rather than a real second. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface GateInterceptor {
  /** Install as `options.hooks.PreToolUse`. */
  readonly hook: HookCallback;
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
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  async function waitForDecision(gateId: string): Promise<GateEntry> {
    let entry = show(input.root, gateId);
    while (entry.status === 'pending') {
      await sleep(pollIntervalMs);
      // Re-read from disk rather than from anything held in memory: the owner
      // decides against the entry file, from a surface this process does not
      // share (SDD §5.1, D-29).
      entry = show(input.root, gateId);
    }
    return entry;
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
    let entry: GateEntry;
    try {
      entry = enqueue(input.root, {
        gateClass: classification.gateClass,
        tourId: input.tourId,
        jobIndex: input.jobIndex,
        interruptedState: input.interruptedState,
        what: classification.what,
        why: classification.why,
        preview: input.buildPreview(classification),
      });
    } catch (error) {
      return refusal(classification, error);
    }

    try {
      return decisionOutcome(await waitForDecision(entry.gateId));
    } catch (error) {
      return refusal(classification, error);
    }
  };

  return { hook };
}
