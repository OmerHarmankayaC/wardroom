import type {
  HookCallback,
  PreToolUseHookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { type CommitOccasion, checkCommit } from '../commit/gate.js';
import { type Duration, formatDuration } from '../config/duration.js';
import { ensureRunDir } from '../config/paths.js';
import type { ProjectConfig } from '../config/schema.js';
import { type ToolCallClassification, classifyToolCall, isCommitCall } from '../gates/classify.js';
import { type Notifier, deliver, parkedNotification } from '../gates/notify.js';
import { authorizationFor, consume, enqueue, park, show } from '../gates/queue.js';
import type { GateEntry, GatePreview } from '../gates/schema.js';
import { checkProgressWrite } from '../progress/write-check.js';
import { stagedPaths } from '../state/git.js';
import { advance } from '../state/machine.js';
import type { StateMarker, TourState } from '../state/marker.js';
import type { VerifyRunner } from '../verify/run.js';

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
  /**
   * The marker as the orchestrator currently holds it.
   *
   * One input rather than four, because `tour_id`, `job_index`, the state a
   * gate would interrupt and `attempt_count` are all already in it, and a
   * second copy of them beside it is a second copy to get out of step. Every
   * marker this module writes goes through the machine from here, so no shape
   * reaches disk that the §3.2 table did not produce (D-47, D-62).
   */
  readonly marker: () => StateMarker;
  /**
   * Builds the class-mandated preview from what the call said.
   *
   * Injected rather than built here because a preview needs what the
   * classifier does not have: a push preview needs the commit list, which needs
   * the repository, and a deployment preview needs the pending migrations,
   * which need the project. The orchestrator holds both.
   */
  readonly buildPreview: (classification: ToolCallClassification) => GatePreview;
  /**
   * The occasion the orchestrator is currently at, for the commit gate
   * (§4.5, D-57). Read at the moment of the call rather than captured at
   * construction: a session commits at the end of a job, and which job that is
   * changes under the same interceptor.
   *
   * Absent means no occasion is known, and a commit is denied on that ground
   * rather than allowed on it: an orchestrator that cannot say where it is has
   * no basis for calling anything a boundary.
   */
  readonly commitOccasion?: () => CommitOccasion;
  /**
   * The green definition run the commit gate uses at a job boundary (§4.3,
   * D-58). Injected so the orchestrator owns the runner; omitted, the gate
   * runs the project's commands for real.
   */
  readonly runVerification?: VerifyRunner;
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
 * The hook's answer for a commit the gate refused.
 *
 * A denial and not an entry: the commit gate is a machine check, not a TD-2
 * class, so it raises nothing, writes no audit line and reaches no owner
 * (§4.5, D-57). What it owes the session is every failing condition at once,
 * because a session told one reason at a time fixes one thing at a time.
 */
function commitRefusal(blocks: readonly string[]): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `The commit gate refused this commit (SDD §4.5, FR-7.1):\n  - ${blocks.join('\n  - ')}`,
    },
  };
}

/**
 * The hook's answer for a write the block guard refused (§4.2, D-39, D-95).
 *
 * A denial and not an entry, for the same reason the commit gate raises none:
 * this is a machine check on what an edit does to one table, not a question
 * anybody puts to the owner.
 */
function blockRefusal(reason: string): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `The Implementer writes the job statuses of the open-tour block and appends a row for a job an audit raised, and nothing else in the document root (SDD §4.2, FR-2.1, D-39, D-95): ${reason}`,
    },
  };
}

/**
 * The answer where the orchestrator cannot say where it is.
 *
 * The marker is read on the hook's hot path, by the block guard and by the
 * gate path both, and a read that throws would leave the hook itself throwing
 * rather than answering. Denying is the only safe answer: a gate raised
 * without the marker would name no tour and no job, and a call let through on
 * that silence is the failure the gate exists to prevent.
 */
function markerRefusal(error: unknown): SyncHookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `The orchestrator could not read its own state marker, so it cannot say where it is: ${error instanceof Error ? error.message : String(error)}. The call is denied rather than taken (SDD §3.3, §4.4 step 1).`,
    },
  };
}

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
  function parkTour(gateId: string, gated: StateMarker): SyncHookJSONOutput {
    const parked = park(input.root, gateId, { now: now() });

    // The outcome is set here, before the two steps that can still fail. The
    // tour parked the moment the entry was stamped, and a marker write or a
    // notifier that goes wrong afterwards must not erase the fact that it did.
    outcome = {
      kind: 'parked',
      gateId,
      interruptedState: gated.interruptedState ?? gated.state,
      parkedAt: parked.parkedAt ?? now().toISOString(),
      notified: false,
    };

    ensureRunDir(input.root);
    // Through the machine, not built by hand. A literal here would write a
    // shape the transition table never produced, and nothing would check it:
    // parking from a state that had never gated would go to disk without
    // complaint. Parking decides nothing, so the gate identifier travels with
    // the state rather than being cleared by it (§3.2, D-62).
    transitionTo(gated, { type: 'park' });

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

  /**
   * Holds a `git commit` while the gate runs (§4.2, §4.5, D-57).
   *
   * The staged set is read from the repository, never from the call: a commit
   * message says nothing about what is staged, and a check that took the
   * committer's word for its own staged set would be the defect D-55 names.
   *
   * A commit that passes falls through untouched rather than being answered
   * `allow`, so the ordinary permission chain still sees it. The gate's job is
   * to block, and a pass is not a reason to skip the rest of the chain.
   */
  function heldCommit(): SyncHookJSONOutput {
    if (input.commitOccasion === undefined) {
      return commitRefusal([
        'occasion: the orchestrator did not say where it is, and an orchestrator that cannot name the occasion has no basis for calling this a boundary (FR-7.1).',
      ]);
    }

    try {
      const verdict = checkCommit(
        input.root,
        input.config,
        { stagedPaths: stagedPaths(input.root), occasion: input.commitOccasion() },
        input.runVerification === undefined ? {} : { runVerification: input.runVerification },
      );
      return verdict.allowed ? UNTOUCHED : commitRefusal(verdict.blocks);
    } catch (error) {
      // Fails closed, for the same reason the gate path does: a check that
      // could not run reported nothing, and a commit created on that silence
      // is the history nobody can bisect that FR-7.1 exists to prevent.
      return commitRefusal([
        `the commit gate could not run: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  }

  /** Applies one transition and writes the marker once (§3.2, D-47). */
  function transitionTo(from: StateMarker, event: Parameters<typeof advance>[2]): StateMarker {
    return advance(input.root, from, event, { attemptBudget: input.config.attemptBudget }, now())
      .marker;
  }

  const hook: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return UNTOUCHED;
    const call = hookInput as PreToolUseHookInput;

    // The commit gate first, because a commit is not a TD-2 class and the
    // classifier will answer null for it. Order matters only in that both
    // questions get asked; no call is both.
    if (isCommitCall(call.tool_name, call.tool_input)) return heldCommit();

    // The marker, once, before anything reads it. Two things below need it and
    // reading it twice was two chances to see two different states inside one
    // call; reading it outside a guard was a hook that throws instead of
    // answering, which the SDK has no rule for.
    let current: StateMarker;
    try {
      current = input.marker();
    } catch (error) {
      return markerRefusal(error);
    }

    // Then the block guard, which is also not a TD-2 class. It is asked in
    // EXECUTING and only there, because that is the state whose contract §4.2
    // is: the block is written by planning in `PLANNING` (§4.1 step 7) and
    // cleared by closure in `CLOSING` (§4.6 step 6), both of them the PM's
    // writes, and D-99 puts one session inside one state, so the state names
    // the writer. Keying on the state rather than on a role also keeps one
    // interceptor installed on both roles, which is what makes neither of them
    // intercepted less than the other (D-43).
    if (current.state === 'EXECUTING') {
      const write = checkProgressWrite({
        root: input.root,
        docRoot: input.config.docRoot,
        toolName: call.tool_name,
        toolInput: call.tool_input,
      });
      if (write.kind === 'block' && !write.verdict.allowed) {
        return blockRefusal(write.verdict.reason);
      }
    }

    const classification = classifyToolCall(call.tool_name, call.tool_input);
    if (classification === null) return UNTOUCHED;

    // An approval standing for exactly this call releases it without asking
    // again (§3.2, D-61). The session that raised the gate does not survive a
    // park, so the approved action is taken by a later session; without this,
    // that session's identical call raises the same gate a second time, which
    // §4.4 forbids, and the owner is asked a question they already answered.
    //
    // Inside the guard, for the same reason the enqueue below is: reading the
    // queue touches the disk, and a read that failed would take the hook with
    // it rather than denying the call.
    try {
      const standing = authorizationFor(input.root, {
        gateClass: classification.gateClass,
        what: classification.what,
        tourId: current.tourId,
      });
      if (standing !== null) {
        consume(input.root, standing.gateId, classification.what, { now: now() });
        return decisionOutcome(standing);
      }
    } catch (error) {
      return refusal(classification, error);
    }

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
          tourId: current.tourId,
          jobIndex: current.jobIndex,
          interruptedState: current.state,
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
      // The marker follows the gate. Without this a death while the gate was
      // pending left the marker reading EXECUTING, and resumption walked
      // straight past a decision the owner had not made, which SDD §4.4's D-24
      // note calls the one failure the gate queue exists to prevent.
      const gated = transitionTo(current, {
        type: 'raise-gate',
        gateClass: classification.gateClass,
        gateId: entry.gateId,
      });

      const waited = await waitForDecision(entry.gateId);
      if (!('decided' in waited)) return parkTour(entry.gateId, gated);

      // The call that raised the gate is the call the approval authorizes, so
      // it spends it here rather than leaving it standing for the next one. An
      // approval nobody spent is a standing permission the owner never granted
      // (FR-3.1, D-61).
      if (waited.decided.status === 'approved') {
        consume(input.root, waited.decided.gateId, classification.what, { now: now() });
      }
      // Either answer returns the tour to the state the gate interrupted; a
      // rejection is recorded as a new job by the loop, not here (§3.2).
      transitionTo(gated, {
        type: 'decide',
        gateClass: classification.gateClass,
        approved: waited.decided.status === 'approved',
        // Nothing about the disposition passes through here since D-101: a
        // gate raised from CLOSING carries it through GATED, so the return
        // finds it still on the marker.
      });
      return decisionOutcome(waited.decided);
    } catch (error) {
      return refusal(classification, error);
    }
  };

  return { hook, outcome: () => outcome };
}
