import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PreToolUseHookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommitOccasion, JobBoundaryOccasion } from '../../src/commit/gate.js';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { readAuditLines } from '../../src/gates/audit.js';
import { isCommitCall } from '../../src/gates/classify.js';
import { list } from '../../src/gates/queue.js';
import type { GatePreview } from '../../src/gates/schema.js';
import { createGateInterceptor } from '../../src/roles/intercept.js';
import { stagedPaths } from '../../src/state/git.js';
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
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const boundary: JobBoundaryOccasion = {
  kind: 'job-boundary',
  tourId: 'tour-3-b-ii',
  jobIndex: 3,
  acceptancePassed: true,
  verificationGreen: true,
};

function buildPreview(): GatePreview {
  throw new Error('a commit raises no gate, so no preview is ever built for one');
}

/** A green definition that passes without spending a suite on it. */
const green: VerifyRunner = () => ({ kind: 'green', ran: ['npm run test'] });

function interceptor(occasion: CommitOccasion = boundary, runVerification: VerifyRunner = green) {
  return createGateInterceptor({
    root,
    config,
    tourId: 'tour-3-b-ii',
    jobIndex: 3,
    interruptedState: 'EXECUTING',
    buildPreview,
    commitOccasion: () => occasion,
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
  occasion?: CommitOccasion,
  runVerification?: VerifyRunner,
): Promise<SyncHookJSONOutput> {
  const { hook } = interceptor(occasion, runVerification);
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

describe('a commit outside the two occasions is denied with the occasion it expected', () => {
  it('denies a checkpoint commit', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "wip: checkpoint"', { kind: 'checkpoint' });

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/job-boundary/);
    expect(reason(output)).toMatch(/wip-stop/);
    expect(reason(output)).toMatch(/checkpoint/);
  });

  it('denies a boundary whose acceptance criterion has not passed', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "feat: one"', {
      ...boundary,
      acceptancePassed: false,
    });

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/acceptance criterion/);
  });

  it('denies a WIP stop on the default branch', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "WIP: stopping"', {
      kind: 'wip-stop',
      reason: 'context running low',
    });

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/default_branch|main/);
  });

  it('reports every failing condition at once, not one refusal at a time', async () => {
    write(join(DOC_ROOT, 'SRS.md'), '# SRS\n\nVersion 1.0 · 2026-08-21\n');
    git('add', '-A');

    const output = await call('git commit -m "x"', { kind: 'autosave' });

    expect(reason(output)).toMatch(/autosave/);
  });

  it('states that this is a machine check and reaches no owner', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call('git commit -m "x"', { kind: 'checkpoint' });

    expect(reason(output)).toMatch(/FR-7\.1/);
    expect(list(root, { includeResolved: true })).toEqual([]);
    expect(readAuditLines(root)).toEqual([]);
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

    const output = await call('git commit -m "feat: one"', boundary, () => ({
      kind: 'failed',
      failure: { command: 'npm run test', exitCode: 1, output: '3 tests failed' },
      ran: ['npm run test'],
    }));

    expect(permission(output)).toBe('deny');
    expect(reason(output)).toMatch(/npm run test/);
    expect(reason(output)).toMatch(/3 tests failed/);
  });

  it('denies it even though the session reported itself green', async () => {
    write('src/one.ts', 'export const one = 1;\n');
    git('add', '-A');

    const output = await call(
      'git commit -m "feat: one"',
      { ...boundary, verificationGreen: true },
      () => ({
        kind: 'failed',
        failure: { command: 'npm run test', exitCode: 1, output: '' },
        ran: ['npm run test'],
      }),
    );

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
      tourId: 'tour-3-b-ii',
      jobIndex: 3,
      interruptedState: 'EXECUTING',
      buildPreview: () => ({
        kind: 'push',
        commits: [{ hash: 'abc1234', subject: 'feat: one' }],
        remote: 'origin',
        branch: 'main',
      }),
      commitOccasion: () => boundary,
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
