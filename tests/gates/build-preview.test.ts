import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../../src/config/schema.js';
import { createPreviewBuilder, roleInState } from '../../src/gates/build-preview.js';
import { type ToolCallClassification, classifyToolCall } from '../../src/gates/classify.js';
import type { StateMarker, TourState } from '../../src/state/marker.js';

/**
 * The class-mandated preview, built from the call and the repository (SDD
 * §3.1, §4.2).
 *
 * This is what the owner decides on, and a preview they cannot read against
 * the action is the same as no preview: a gate without its preview must not be
 * enqueued at all (D-32). So each class is checked for the fields §3.1 names,
 * against classifications the classifier actually produced rather than
 * structures assembled here (D-55): the builder's input comes from the
 * classifier, and a test that built its own would be checking a shape nothing
 * produces.
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

function marker(overrides: Partial<StateMarker> = {}): StateMarker {
  return {
    state: 'EXECUTING',
    tourId: 'tour-9',
    jobIndex: 2,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: null,
    headCommit: null,
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-qm', message);
}

/** The classification the classifier makes of a call, refused where it makes none. */
function classified(toolName: string, toolInput: unknown): ToolCallClassification {
  const classification = classifyToolCall(toolName, toolInput);
  if (classification === null) {
    throw new Error(`the classifier does not gate ${toolName} ${JSON.stringify(toolInput)}`);
  }
  return classification;
}

function build(at: StateMarker = marker()) {
  return createPreviewBuilder({ root, config, marker: () => at });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-preview-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'f@example.invalid');
  git('config', 'user.name', 'Fixture');
  write('README.md', '# fixture\n');
  commit('the first commit');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the push preview names the commits the push would carry', () => {
  it('lists every commit where the remote has never seen the branch', () => {
    write('src/a.ts', 'export const a = 1;\n');
    commit('the second commit');

    const preview = build()(classified('Bash', { command: 'git push origin main' }));

    expect(preview.kind).toBe('push');
    if (preview.kind !== 'push') return;
    // Two commits and not none: a branch the remote has never seen is a branch
    // the push carries whole, which is a different fact from nothing to push.
    expect(preview.commits.map((entry) => entry.subject)).toEqual([
      'the second commit',
      'the first commit',
    ]);
    expect(preview.commits.every((entry) => entry.hash.length > 0)).toBe(true);
  });

  it('lists only what the remote does not carry, where a tracking ref exists', () => {
    // A remote whose ref sits at the first commit, so the second is the only
    // thing the push would carry.
    const at = git('rev-parse', 'HEAD').trim();
    git('update-ref', 'refs/remotes/origin/main', at);
    write('src/a.ts', 'export const a = 1;\n');
    commit('the only unpushed commit');

    const preview = build()(classified('Bash', { command: 'git push origin main' }));

    expect(preview.kind === 'push' && preview.commits.map((entry) => entry.subject)).toEqual([
      'the only unpushed commit',
    ]);
  });

  it('falls back to the contract default branch where the command names none', () => {
    const preview = build()(classified('Bash', { command: 'git push' }));

    expect(preview.kind === 'push' && preview.remote).toBe('origin');
    expect(preview.kind === 'push' && preview.branch).toBe(config.defaultBranch);
  });

  it('carries the remote and branch the command did name', () => {
    const preview = build()(classified('Bash', { command: 'git push upstream release' }));

    expect(preview.kind === 'push' && preview.remote).toBe('upstream');
    expect(preview.kind === 'push' && preview.branch).toBe('release');
  });
});

describe('the destructive preview names the command and what it reaches', () => {
  it('carries the command as it was made, not a paraphrase of it', () => {
    const command = 'rm -rf ./build ./dist';
    const preview = build()(classified('Bash', { command }));

    expect(preview.kind).toBe('destructive');
    expect(preview.kind === 'destructive' && preview.command).toBe(command);
  });

  it('lists the path-like arguments and not the flags', () => {
    const preview = build()(classified('Bash', { command: 'rm -rf ./build ./dist' }));

    expect(preview.kind === 'destructive' && preview.affects).toEqual(['./build', './dist']);
  });
});

describe('the secrets preview says which secret, who asked and from where', () => {
  const call = { command: 'cat .env' };

  it('carries the secret and the call verbatim, and never a value', () => {
    const preview = build()(classified('Bash', call));

    expect(preview.kind).toBe('secrets');
    if (preview.kind !== 'secrets') return;
    expect(preview.call).toBe(call.command);
    expect(preview.secret.length).toBeGreaterThan(0);
  });

  it('names the job it was raised from, as the tour and the index', () => {
    const preview = build(marker({ tourId: 'tour-9', jobIndex: 2 }))(classified('Bash', call));

    expect(preview.kind === 'secrets' && preview.job).toBe('tour-9 job 2');
  });

  it('says the job is null before a tour record exists, which is a fact (D-45, D-70)', () => {
    const preview = build(marker({ state: 'PLANNING', tourId: null, jobIndex: null }))(
      classified('Bash', call),
    );

    expect(preview.kind === 'secrets' && preview.job).toBeNull();
  });

  it('names the role the state holds, so one interceptor can serve both (D-99)', () => {
    const asImplementer = build(marker({ state: 'EXECUTING' }))(classified('Bash', call));
    const asPm = build(marker({ state: 'CLOSING', disposition: 'closed' }))(
      classified('Bash', call),
    );

    expect(asImplementer.kind === 'secrets' && asImplementer.role).toBe('implementer');
    expect(asPm.kind === 'secrets' && asPm.role).toBe('pm');
  });
});

describe('the role is read from the state, and from the interrupted one where gated', () => {
  for (const [state, role] of [
    ['EXECUTING', 'implementer'],
    ['PLANNING', 'pm'],
    ['CLOSING', 'pm'],
  ] as const) {
    it(`reads ${state} as the ${role}`, () => {
      expect(roleInState(marker({ state: state as TourState }))).toBe(role);
    });
  }

  it('reads a gated marker as the role of the state the gate interrupted', () => {
    // The gate is raised from inside a session, so the role that asked is the
    // one holding the state the gate interrupted, not `GATED` itself.
    expect(
      roleInState(marker({ state: 'GATED', interruptedState: 'EXECUTING', gateId: 'g-1' })),
    ).toBe('implementer');
    expect(
      roleInState(marker({ state: 'PARKED', interruptedState: 'CLOSING', gateId: 'g-1' })),
    ).toBe('pm');
  });
});
