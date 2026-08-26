import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { readAuditLines } from '../../src/gates/audit.js';
import { isCommitCall } from '../../src/gates/classify.js';
import { list } from '../../src/gates/queue.js';
import type { GatePreview } from '../../src/gates/schema.js';
import { createGateInterceptor } from '../../src/roles/intercept.js';
import { stagedPaths } from '../../src/state/git.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';
import type { VerifyRunner } from '../../src/verify/run.js';

/**
 * `git commit` is intercepted and the commit gate runs there (SDD §4.2, §4.5,
 * D-57).
 *
 * The sessions create the commits, not the orchestrator, so a gate stating its
 * check without stating its invocation point enforced nothing: FR-7.1 was
 * carried by instruction through three tours while the gate itself existed
 * (T-6). This is the wiring.
 *
 * It is a machine check and not a TD-2 class. It raises no entry, writes no
 * audit line, and reaches no owner, and the tests below assert all three
 * absences as hard as they assert the denial.
 */

let root: string;

const DOC_ROOT = 'internal/docs';

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: DOC_ROOT,
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['npm run test'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 3,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-commit-hook-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  write('README.md', '# fixture\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  ensureRunDir(root);
  writeMarker(root, EXECUTING_MARKER);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The marker the orchestrator holds while the session works. */
const EXECUTING_MARKER: StateMarker = {
  state: 'EXECUTING',
  tourId: 'tour-3-b-ii',
  jobIndex: 3,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  disposition: null,
  headCommit: null,
  updatedAt: '2026-08-21T08:00:00.000Z',
};

/** The marker of a tour whose PM is closing it (§4.6, D-76). */
const CLOSING_MARKER: StateMarker = {
  ...EXECUTING_MARKER,
  state: 'CLOSING',
  jobIndex: null,
  disposition: 'closed',
};

/** A state that is no occasion at all: the tour is between two of them. */
const VERIFYING_MARKER: StateMarker = {
  ...EXECUTING_MARKER,
  state: 'VERIFYING',
  jobIndex: null,
};

function buildPreview(): GatePreview {
  throw new Error('a commit raises no gate, so no preview is ever built for one');
}

/** A green definition that passes without spending a suite on it. */
const green: VerifyRunner = () => ({ kind: 'green', ran: ['npm run test'] });

function interceptor(
  marker: StateMarker = EXECUTING_MARKER,
  runVerification: VerifyRunner = green,
) {
  return createGateInterceptor({
    root,
    config,
    marker: () => marker,
    buildPreview,
    runVerification,
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

async function call(
  command: string,
  marker?: StateMarker,
  runVerification?: VerifyRunner,
): Promise<SyncHookJSONOutput> {
  const { hook } = interceptor(marker, runVerification);
  return (await hook(toolCall('Bash', { command }), 'tu-1', {
    signal: new AbortController().signal,
  })) as SyncHookJSONOutput;
}

function permission(output: SyncHookJSONOutput): string | undefined {
  const specific = output.hookSpecificOutput;
  return specific?.hookEventName === 'PreToolUse' ? specific.permissionDecision : undefined;
}

function reason(output: SyncHookJSONOutput): string {
  const specific = output.hookSpecificOutput;
  return specific?.hookEventName === 'PreToolUse'
    ? (specific.permissionDecisionReason ?? '')
    : '<not a PreToolUse output>';
}

describe('a commit call is recognised without being a gate class', () => {
  it.each([
    'git commit -m "feat: something"',
    'git commit --amend',
    'cd sub && git commit -m x',
    'git -c user.name=x commit -m y',
  ])('recognises %s', (command) => {
    expect(isCommitCall('Bash', { command })).toBe(true);
  });

  it.each(['git commit-tree abc', 'npm run test', 'git status --short', 'git log --oneline'])(
    'does not recognise %s',
    (command) => {
      expect(isCommitCall('Bash', { command })).toBe(false);
    },
  );

  it('is not recognised through a tool that is not the shell', () => {
    expect(isCommitCall('Read', { file_path: 'git commit' })).toBe(false);
  });
});

describe('the staged set is read from the repository, not from the call', () => {
  it('lists what git has staged, and nothing merely modified', () => {
    write('src/one.ts', 'export const one = 1;\n');
    write('src/two.ts', 'export const two = 2;\n');
    git('add', 'src/one.ts');

    expect(stagedPaths(root)).toEqual(['src/one.ts']);
  });

  it('is empty when nothing is staged', () => {
    expect(stagedPaths(root)).toEqual([]);
  });

  it('lists a staged deletion, which is the case the gate blocks on', () => {
    git('rm', '-q', 'README.md');

    expect(stagedPaths(root)).toEqual(['README.md']);
  });
});

describe('a commit at a job boundary passes through the gate', () => {
  it('is not denied', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "feat: one"');

    expect(permission(output)).not.toBe('deny');
  });

  it('raises no gate entry and writes no audit line, because it is not a TD-2 class', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    await call('git commit -m "feat: one"');

    expect(list(root, { includeResolved: true })).toEqual([]);
    expect(readAuditLines(root)).toEqual([]);
  });
});

describe('the occasion is derived from the marker, and nothing passes one in (D-105)', () => {
  it('denies a commit from a state that is no occasion at all', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "chore: checkpoint"', VERIFYING_MARKER);

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/VERIFYING/);
    expect(reason(output)).toMatch(/EXECUTING/);
    expect(reason(output)).toMatch(/CLOSING/);
    expect(reason(output)).toMatch(/WIP:/);
  });

  it('denies a commit in EXECUTING with no job index, which names no boundary', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "chore: checkpoint"', {
      ...EXECUTING_MARKER,
      jobIndex: null,
    });

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/no job index/);
  });

  it('takes the closure occasion from CLOSING without being told', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    // No green run for a closure, so a runner that would fail proves the
    // occasion reached the gate as a closure and not as a boundary.
    const output = await call('git commit -m "docs: close the tour"', CLOSING_MARKER, () => ({
      kind: 'failed',
      failure: { command: 'npm run test', exitCode: 1, output: 'red' },
      ran: ['npm run test'],
    }));

    expect(permission(output)).not.toBe('deny');
  });

  it('reads the disposition off the marker rather than deriving one (D-101)', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    // A shape the marker schema forbids. Reaching the gate with it means
    // something other than the machine wrote the marker, and deriving `closed`
    // here would record a disposition nothing decided, on the one commit of a
    // tour that carries its documents.
    const output = await call('git commit -m "docs: close the tour"', {
      ...CLOSING_MARKER,
      disposition: null,
    });

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/disposition/);
  });

  it('denies a WIP stop on the default branch, whatever the marker says', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "WIP: stopping, context running low"');

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/default_branch|main/);
  });

  it('reaches the WIP occasion from EXECUTING, which also derives the boundary', async () => {
    // The stop happens inside EXECUTING and no marker field moves when it
    // does, so a derivation that asked the marker first would make the WIP
    // occasion unreachable. It is recognised from the subject the loop itself
    // writes, and the branch check below is what still holds it honest.
    git('checkout', '-q', '-b', 'wip/tour-4-job-1');
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    // A runner that would fail: a WIP stop runs no green definition, which is
    // the whole point of the occasion, so passing here says the derivation did
    // not fall through to the boundary.
    const output = await call(
      'git commit -m "WIP: stopping, context running low"',
      undefined,
      () => ({
        kind: 'failed',
        failure: { command: 'npm run test', exitCode: 1, output: 'red' },
        ran: ['npm run test'],
      }),
    );

    expect(permission(output)).not.toBe('deny');
  });

  it('denies a commit the orchestrator cannot place, without reaching the owner', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "chore: checkpoint"', VERIFYING_MARKER);

    expect(reason(output)).toMatch(/FR-7\.1/);
    expect(list(root, { includeResolved: true })).toEqual([]);
    expect(readAuditLines(root)).toEqual([]);
  });

  it('denies the call when the marker cannot be read at all', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const { hook } = createGateInterceptor({
      root,
      config,
      marker: () => {
        throw new Error('the marker is unreadable');
      },
      buildPreview,
      runVerification: green,
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    const output = (await hook(toolCall('Bash', { command: 'git commit -m "feat: one"' }), 'tu-1', {
      signal: new AbortController().signal,
    })) as SyncHookJSONOutput;

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/unreadable/);
  });
});

describe('one session reaches two occasions under one interceptor (D-99, D-105)', () => {
  it('derives a boundary and then a closure from the same hook', async () => {
    // The mechanical half of D-105: the occasion used to be fixed when the
    // session was built, and one Implementer session spans many boundaries, so
    // a value captured once could not have been right for all of them. The
    // marker here moves between two calls to ONE hook.
    let marker: StateMarker = EXECUTING_MARKER;
    const { hook } = createGateInterceptor({
      root,
      config,
      marker: () => marker,
      buildPreview,
      // Red, so a closure that was read as a boundary would be denied.
      runVerification: () => ({
        kind: 'failed',
        failure: { command: 'npm run test', exitCode: 1, output: 'red' },
        ran: ['npm run test'],
      }),
      sleep: () => new Promise((resolve) => setImmediate(resolve)),
    });
    const ask = async (command: string) =>
      (await hook(toolCall('Bash', { command }), 'tu-1', {
        signal: new AbortController().signal,
      })) as SyncHookJSONOutput;

    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');
    const atBoundary = await ask('git commit -m "feat: job 1"');

    marker = CLOSING_MARKER;
    const atClosure = await ask('git commit -m "docs: close the tour"');

    expect(permission(atBoundary)).toBe('deny');
    expect(reason(atBoundary)).toMatch(/not green/);
    expect(permission(atClosure)).not.toBe('deny');
  });
});

describe("the staged set the gate judges is the repository's, not the call's", () => {
  /** A canonical document in the shape every one in this project uses. */
  function srs(version: string, body: string): string {
    return [
      '# Software Requirements Specification',
      '',
      `Version ${version} · 2026-08-21`,
      '',
      '| Version | Date | Change |',
      '|---|---|---|',
      `| ${version} | 2026-08-21 | a row |`,
      '',
      body,
      '',
    ].join('\n');
  }

  beforeEach(() => {
    write(join(DOC_ROOT, 'SRS.md'), srs('1.0', '## 1. Overview'));
    git('add', '-A');
    git('commit', '-qm', 'docs: SRS 1.0');
  });

  it('denies a commit whose staged document moved without its version', async () => {
    // The mutation this exists for: handing the gate an empty staged set makes
    // the document check find nothing to check and report clean. Every
    // occasion test above passes under that mutation, because none of them
    // stages a document. This one does.
    write(join(DOC_ROOT, 'SRS.md'), srs('1.0', '## 1. Overview, rewritten'));
    git('add', '-A');

    const output = await call('git commit -m "docs: edit"');

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/SRS\.md/);
  });

  it('denies a staged deletion of a version-carrying document', async () => {
    git('rm', '-q', join(DOC_ROOT, 'SRS.md'));

    const output = await call('git commit -m "docs: remove SRS"');

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/SRS\.md/);
  });

  it('allows the same edit once the version and its row move with it', async () => {
    write(join(DOC_ROOT, 'SRS.md'), srs('1.1', '## 1. Overview, rewritten'));
    git('add', '-A');

    const output = await call('git commit -m "docs: SRS 1.1"');

    expect(permission(output)).not.toBe('deny');
  });
});

describe('the denial from a red boundary reaches the session', () => {
  it('carries the failing command and its output', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "feat: one"', EXECUTING_MARKER, () => ({
      kind: 'failed',
      failure: { command: 'npm run test', exitCode: 1, output: '3 tests failed' },
      ran: ['npm run test'],
    }));

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/npm run test/);
    expect(reason(output)).toMatch(/3 tests failed/);
  });

  it('has no field a session could have claimed green with (D-58, D-105)', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    // Nothing passes an occasion in, so the only account of greenness that
    // exists is the run the gate makes itself. The call below says `green` in
    // its own message and is denied anyway.
    const output = await call('git commit -m "feat: one, all green"', undefined, () => ({
      kind: 'failed',
      failure: { command: 'npm run test', exitCode: 1, output: '' },
      ran: ['npm run test'],
    }));

    expect(permission(output)).toBe('deny');
  });
});

describe('an ordinary shell call is untouched', () => {
  it('passes a green definition command through', async () => {
    expect(await call('npm run test')).toEqual({});
  });

  it('passes a git call that is not a commit through', async () => {
    expect(await call('git status --short')).toEqual({});
  });

  it('still gates a push, which is a TD-2 class and not a commit', async () => {
    // The clock advances by the whole waiting period on the first poll, so the
    // call parks rather than hanging. What matters here is that an entry was
    // raised at all, which a commit never does.
    let clock = new Date('2026-09-01T00:00:00.000Z');
    const { hook } = createGateInterceptor({
      root,
      config,
      marker: () => EXECUTING_MARKER,
      buildPreview: () => ({
        kind: 'push',
        commits: [{ hash: 'abc1234', subject: 'feat: one' }],
        remote: 'origin',
        branch: 'main',
      }),
      runVerification: green,
      pollIntervalMs: config.gateWait.milliseconds,
      now: () => clock,
      sleep: (ms) =>
        new Promise((resolve) => {
          clock = new Date(clock.getTime() + ms);
          setImmediate(resolve);
        }),
    });

    await hook(toolCall('Bash', { command: 'git push origin main' }), 'tu-1', {
      signal: new AbortController().signal,
    });

    expect(list(root, { includeResolved: true })).toHaveLength(1);
  });
});
