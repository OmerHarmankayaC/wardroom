import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { readAuditLines } from '../../src/gates/audit.js';
import type { ToolCallClassification } from '../../src/gates/classify.js';
import { decide, list } from '../../src/gates/queue.js';
import type { GateEntry, GatePreview } from '../../src/gates/schema.js';
import { createGateInterceptor, decisionOutcome } from '../../src/roles/intercept.js';

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

function interceptor() {
  return createGateInterceptor({
    root,
    config,
    tourId: 'tour-3-b-i',
    jobIndex: 3,
    interruptedState: 'EXECUTING',
    buildPreview,
    // The wait is driven by the test rather than by the clock, so the poll is a
    // yield and the suite does not spend real seconds proving a loop loops.
    sleep: () => new Promise((resolve) => setImmediate(resolve)),
  });
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
    const { hook } = createGateInterceptor({
      root,
      config,
      tourId: 'tour-3-b-i',
      jobIndex: 3,
      interruptedState: 'EXECUTING',
      buildPreview: () => {
        throw new Error('the remote is unreachable');
      },
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
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
    const { hook } = createGateInterceptor({
      root,
      config,
      tourId: 'tour-3-b-i',
      jobIndex: 3,
      interruptedState: 'EXECUTING',
      // An empty commit list is refused by the preview contract (D-32).
      buildPreview: () => ({ kind: 'push', commits: [], remote: 'origin', branch: 'main' }),
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });

    const output = (await hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;

    expect(permission(output)).toBe('deny');
    expect(list(root, { includeResolved: true })).toEqual([]);
  });
});
