import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { readAuditLines } from '../../src/gates/audit.js';
import type { ToolCallClassification } from '../../src/gates/classify.js';
import type { ParkedNotification } from '../../src/gates/notify.js';
import { decide, list } from '../../src/gates/queue.js';
import type { GateEntry, GatePreview } from '../../src/gates/schema.js';
import {
  createGateInterceptor,
  decisionOutcome,
  isErrorOutcome,
  parkingDeadline,
} from '../../src/roles/intercept.js';
import { readMarker } from '../../src/state/marker.js';

/**
 * Gate interception as a `PreToolUse` hook (SDD §4.2, §3.1, D-43).
 *
 * The hook is the only placement that cannot be switched off from elsewhere in
 * the configuration: it runs before every other permission step and its denial
 * holds even in `bypassPermissions`. What is asserted here is the thing that
 * makes it a gate rather than a log: the call does not proceed while the entry
 * is pending, and what it does when the entry resolves is read off the entry.
 */

let root: string;

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: 'internal/docs',
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['npm run test'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 3,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-intercept-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  // A real repository, because parking writes the marker and the marker
  // carries the HEAD commit it was written at (SDD §3.3).
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function buildPreview(classification: ToolCallClassification): GatePreview {
  if (classification.detail.kind !== 'push') throw new Error('fixture builds push previews only');
  return {
    kind: 'push',
    commits: [{ hash: '16117aa', subject: 'test: bind the two homes' }],
    remote: classification.detail.remote ?? 'origin',
    branch: classification.detail.branch ?? 'main',
  };
}

/**
 * One fixture for every interceptor in this file.
 *
 * There were four hand-built copies of this before the whole-tour audit, and
 * the same mistake was made in two of them: a clock that never moves cannot
 * reach a deadline measured from that same clock, so the wait hung. A fixture
 * whose clock advances by construction is the fix for the bug and for the
 * duplication that let it be made twice.
 */
interface Fixture {
  readonly gateWaitMs?: number;
  readonly pollIntervalMs?: number;
  /** Milliseconds the clock advances per sleep; the poll interval by default. */
  readonly tickMs?: number;
  readonly attemptCount?: number;
  readonly notify?: (notification: ParkedNotification) => void;
  readonly buildPreview?: (classification: ToolCallClassification) => GatePreview;
  /** Runs on each sleep, before the clock advances. */
  readonly onSleep?: () => void;
}

const BASE_TIME = new Date('2026-08-21T09:00:00.000Z');

function interceptor(fixture: Fixture = {}) {
  const pollIntervalMs = fixture.pollIntervalMs ?? 400;
  const tickMs = fixture.tickMs ?? pollIntervalMs;
  const gateWaitMs = fixture.gateWaitMs ?? config.gateWait.milliseconds;
  let clock = BASE_TIME;
  let slept = 0;

  const built = createGateInterceptor({
    root,
    config: {
      ...config,
      gateWait: { value: Math.round(gateWaitMs / 1_000), unit: 's', milliseconds: gateWaitMs },
    },
    tourId: 'tour-3-b-i',
    jobIndex: 3,
    interruptedState: 'EXECUTING',
    buildPreview: fixture.buildPreview ?? buildPreview,
    pollIntervalMs,
    now: () => clock,
    // The wait is driven by the test rather than by the clock, so the poll is a
    // yield and the suite does not spend real seconds proving a loop loops.
    sleep: () =>
      new Promise((resolve) => {
        slept += 1;
        fixture.onSleep?.();
        clock = new Date(clock.getTime() + tickMs);
        setImmediate(resolve);
      }),
    ...(fixture.attemptCount === undefined ? {} : { attemptCount: fixture.attemptCount }),
    ...(fixture.notify === undefined ? {} : { notify: fixture.notify }),
  });

  return { ...built, sleeps: () => slept };
}

function toolCall(toolName: string, toolInput: unknown): PreToolUseHookInput {
  return {
    session_id: 's-1',
    transcript_path: '/dev/null',
    cwd: root,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: 'tu-1',
  };
}

function call(toolName: string, toolInput: unknown) {
  const { hook } = interceptor();
  return hook(toolCall(toolName, toolInput), 'tu-1', { signal: new AbortController().signal });
}

/** Lets the hook reach its first poll before the test looks at the queue. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function permission(output: SyncHookJSONOutput): string | undefined {
  const specific = output.hookSpecificOutput;
  return specific?.hookEventName === 'PreToolUse' ? specific.permissionDecision : undefined;
}

describe('a gated call raises an entry and does not proceed', () => {
  it('writes a pending entry carrying its class preview', async () => {
    const pending = call('Bash', { command: 'git push origin main' });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await settle();

    const entries = list(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('pending');
    expect(entries[0]?.gateClass).toBe('push');
    expect(entries[0]?.preview).toEqual({
      kind: 'push',
      commits: [{ hash: '16117aa', subject: 'test: bind the two homes' }],
      remote: 'origin',
      branch: 'main',
    });
    expect(settled).toBe(false);

    decide(root, entries[0]?.gateId ?? '', 'approved', 'owner');
    await pending;
  });

  it('carries the tour position the interceptor was built with', async () => {
    const pending = call('Bash', { command: 'git push origin main' });
    await settle();

    const entry = list(root)[0] as GateEntry;
    expect({
      tourId: entry.tourId,
      jobIndex: entry.jobIndex,
      interruptedState: entry.interruptedState,
    }).toEqual({ tourId: 'tour-3-b-i', jobIndex: 3, interruptedState: 'EXECUTING' });

    decide(root, entry.gateId, 'rejected', 'owner');
    await pending;
  });

  it('writes the audit line ahead of the action it records', async () => {
    const pending = call('Bash', { command: 'git push origin main' });
    await settle();

    const lines = readAuditLines(root);
    expect(lines.map((line) => line.event)).toEqual(['enqueued']);
    expect(lines[0]?.gateId).toBe(list(root)[0]?.gateId);

    decide(root, list(root)[0]?.gateId ?? '', 'approved', 'owner');
    await pending;
  });
});

describe('the decision reaches the session', () => {
  it('releases the call when the owner approves', async () => {
    const pending = call('Bash', { command: 'git push origin main' });
    await settle();
    decide(root, list(root)[0]?.gateId ?? '', 'approved', 'owner');

    expect(permission((await pending) as SyncHookJSONOutput)).toBe('allow');
  });

  it('denies the call when the owner rejects, and says why', async () => {
    const pending = call('Bash', { command: 'git push origin main' });
    await settle();
    decide(root, list(root)[0]?.gateId ?? '', 'rejected', 'owner', 'not before the tour closes');

    const output = (await pending) as SyncHookJSONOutput;
    expect(permission(output)).toBe('deny');
    const specific = output.hookSpecificOutput;
    const reason =
      specific?.hookEventName === 'PreToolUse' ? specific.permissionDecisionReason : '';
    expect(reason).toContain('not before the tour closes');
    expect(reason).toContain('owner');
  });
});

describe('an ungated call passes through untouched', () => {
  it('returns an empty output for a green definition command', async () => {
    expect(await call('Bash', { command: 'npm run test' })).toEqual({});
  });

  it('raises no entry and writes no audit line', async () => {
    await call('Read', { file_path: '/repo/src/index.ts' });

    expect(list(root, { includeResolved: true })).toEqual([]);
    expect(readAuditLines(root)).toEqual([]);
  });

  it('ignores an event that is not PreToolUse', async () => {
    const { hook } = interceptor();
    const output = await hook(
      {
        ...toolCall('Bash', { command: 'git push origin main' }),
        hook_event_name: 'PostToolUse',
        tool_response: 'done',
      },
      'tu-1',
      { signal: new AbortController().signal },
    );

    expect(output).toEqual({});
    expect(list(root, { includeResolved: true })).toEqual([]);
  });
});

describe('the outcome is read off the entry, never assumed', () => {
  const approved = { status: 'approved', decidedBy: 'owner', decisionNote: null } as GateEntry;
  const rejected = { status: 'rejected', decidedBy: 'owner', decisionNote: null } as GateEntry;

  /** The property that makes the hook a gate, as an assertion. */
  function expectHonoursDecision(outcome: (entry: GateEntry) => SyncHookJSONOutput): void {
    expect(permission(outcome(approved))).toBe('allow');
    expect(permission(outcome(rejected))).toBe('deny');
  }

  it('holds for the hook', () => {
    expectHonoursDecision(decisionOutcome);
  });

  it('fails for a hook mutated to allow without consulting the entry', () => {
    // The mutation this assertion exists for: a hook that answers `allow`
    // whatever the entry says is a hook that raised a gate and then walked
    // past it, and the entry on disk would still read `rejected`.
    const mutant = (): SyncHookJSONOutput => ({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' },
    });

    expect(() => expectHonoursDecision(mutant)).toThrowError();
  });

  it('refuses to answer for an entry nobody has decided', () => {
    expect(() => decisionOutcome({ status: 'pending' } as GateEntry)).toThrowError();
  });
});

describe('a gate that cannot be raised denies rather than passing', () => {
  it('denies when the preview cannot be built', async () => {
    const { hook } = interceptor({
      buildPreview: () => {
        throw new Error('the remote is unreachable');
      },
    });

    const output = (await hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;

    // A gate the orchestrator failed to raise reported nothing, and a call
    // that proceeds on that silence is exactly the failure the gate exists to
    // prevent. It fails closed, and says what went wrong.
    expect(permission(output)).toBe('deny');
    const specific = output.hookSpecificOutput;
    const reason =
      specific?.hookEventName === 'PreToolUse' ? specific.permissionDecisionReason : '';
    expect(reason).toContain('the remote is unreachable');
  });

  it('denies when the entry cannot be enqueued', async () => {
    // An empty commit list is refused by the preview contract (D-32).
    const { hook } = interceptor({
      buildPreview: () => ({ kind: 'push', commits: [], remote: 'origin', branch: 'main' }),
    });

    const output = (await hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;

    expect(permission(output)).toBe('deny');
    expect(list(root, { includeResolved: true })).toEqual([]);
  });
});

describe('gate_wait elapsing parks the tour', () => {
  /** A waiting period the fixture's clock crosses in three polls. */
  function parking(notify?: (notification: ParkedNotification) => void) {
    return interceptor({
      gateWaitMs: 1_000,
      attemptCount: 2,
      ...(notify === undefined ? {} : { notify }),
    });
  }

  async function park(interceptorUnderTest: ReturnType<typeof interceptor>): Promise<void> {
    await interceptorUnderTest.hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    });
  }

  it('leaves the gate pending and stamps parked_at', async () => {
    const parker = parking();
    await park(parker);

    const entry = list(root)[0] as GateEntry;
    expect(entry.status).toBe('pending');
    expect(entry.parkedAt).not.toBeNull();
    expect(entry.decidedAt).toBeNull();
  });

  it('records the parking in the audit log, after the entry was enqueued', async () => {
    const parker = parking();
    await park(parker);

    expect(readAuditLines(root).map((line) => line.event)).toEqual(['enqueued', 'parked']);
  });

  it('writes the marker as PARKED carrying the state it interrupted', async () => {
    const parker = parking();
    await park(parker);

    const read = readMarker(root);
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.marker.state).toBe('PARKED');
    expect(read.marker.interruptedState).toBe('EXECUTING');
    expect(read.marker.tourId).toBe('tour-3-b-i');
    expect(read.marker.jobIndex).toBe(3);
    expect(read.marker.attemptCount).toBe(2);
  });

  it('emits the notification, saying what was parked and why', async () => {
    const seen: ParkedNotification[] = [];
    await park(parking((notification) => seen.push(notification)));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('tour-parked');
    expect(seen[0]?.gateClass).toBe('push');
    expect(seen[0]?.interruptedState).toBe('EXECUTING');
    expect(seen[0]?.waited).toBe('1s');
  });

  it('parks anyway when the notifier fails, because the entry is the record', async () => {
    const parker = parking(() => {
      throw new Error('no surface attached');
    });
    await park(parker);

    expect((list(root)[0] as GateEntry).parkedAt).not.toBeNull();
    expect(parker.outcome().kind).toBe('parked');
  });

  it('ends the run without an error, and stops the session', async () => {
    const parker = parking();
    const output = (await parker.hook(
      toolCall('Bash', { command: 'git push origin main' }),
      'tu-1',
      {
        signal: new AbortController().signal,
      },
    )) as SyncHookJSONOutput;

    // Parking is a release, not a decision (SDD §3.2): the call does not
    // proceed, and the gate is still waiting for the owner.
    expect(output.continue).toBe(false);
    expect(permission(output)).toBe('deny');
    expect(output.stopReason).toMatch(/parked/i);

    const outcome = parker.outcome();
    expect(outcome.kind).toBe('parked');
    expect(isErrorOutcome(outcome)).toBe(false);
  });

  it('reports running until something parks', () => {
    expect(parking().outcome()).toEqual({ kind: 'running' });
  });

  it('does not park a gate the owner answers inside the waiting period', async () => {
    let answered = false;
    // The owner answers during the first wait, which is still well inside the
    // period. Deterministic: the decision lands between two reads of the entry
    // rather than racing them.
    const answering = interceptor({
      gateWaitMs: 1_000,
      onSleep: () => {
        if (answered) return;
        answered = true;
        decide(root, list(root)[0]?.gateId ?? '', 'approved', 'owner');
      },
    });

    const output = (await answering.hook(
      toolCall('Bash', { command: 'git push origin main' }),
      'tu-1',
      { signal: new AbortController().signal },
    )) as SyncHookJSONOutput;

    expect(permission(output)).toBe('allow');
    expect((list(root, { includeResolved: true })[0] as GateEntry).parkedAt).toBeNull();
    expect(answering.outcome()).toEqual({ kind: 'running' });
  });

  it('measures the period from when the gate was raised, not from when the wait began', () => {
    // A run that died and came back must not hand the same gate a fresh waiting
    // period every restart, or a gate that restarts often enough never parks.
    const entry = { requestedAt: '2026-08-21T09:00:00.000Z' } as GateEntry;

    expect(parkingDeadline(entry, { value: 1, unit: 's', milliseconds: 1_000 })).toBe(
      new Date('2026-08-21T09:00:01.000Z').getTime(),
    );
  });
});

describe('the waiting period has two edges and both are named', () => {
  /**
   * Runs the wait with a clock that advances `tickMs` per poll, and reports how
   * many polls it took to park. The sleep count is the answer to "which side of
   * the deadline is this instant on": with a tick of exactly the period, the
   * second read lands on the deadline and one sleep is enough.
   */
  async function sleepsBeforeParking(tickMs: number): Promise<number> {
    const parker = interceptor({ gateWaitMs: 1_000, pollIntervalMs: 0, tickMs });

    await parker.hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    });
    expect(parker.outcome().kind).toBe('parked');
    return parker.sleeps();
  }

  it('has elapsed at the deadline itself', async () => {
    // The clock reaches exactly `requested_at + gate_wait` on the second read,
    // so a deadline tested as "past" rather than "reached" would need a third.
    expect(await sleepsBeforeParking(1_000)).toBe(1);
  });

  it('has not elapsed one millisecond before it', async () => {
    expect(await sleepsBeforeParking(999)).toBe(2);
  });
});

describe('the tour parked the moment the entry was stamped', () => {
  it('keeps the parked outcome when the marker cannot be written', async () => {
    const parker = interceptor({ gateWaitMs: 1_000, pollIntervalMs: 1_000 });

    // The marker's own path is occupied by a directory, so the atomic rename
    // onto it fails while the gate queue beside it keeps working.
    mkdirSync(wardroomPaths(root).stateFile, { recursive: true });

    await parker.hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    });

    expect(parker.outcome().kind).toBe('parked');
  });
});
