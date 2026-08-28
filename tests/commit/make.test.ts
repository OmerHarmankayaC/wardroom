import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommit } from '../../src/commit/make.js';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { recordClosureBaseline } from '../../src/documents/baseline.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';
import type { VerifyRunner } from '../../src/verify/run.js';

/**
 * The commit the orchestrator makes itself (SDD §4.5, §4.6 step 7, D-112).
 *
 * Two of FR-7.1's three occasions have no session behind them, so the gate is
 * a function with two callers rather than a hook with one. This is the second
 * caller: it stages, asks the gate, and either commits or reports why it did
 * not.
 *
 * Every assertion here reads `.git` rather than the return value wherever the
 * two could differ (D-55). A maker that reported `committed: true` and created
 * nothing would pass a test that believed its own answer, and that is exactly
 * the failure this job exists to fix one level up: closure recorded a commit
 * from the presence of a committer rather than from a commit.
 */

let root: string;
const DOCS = 'docs';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function configFor(docRoot: string): ProjectConfig {
  return {
    name: 'example',
    level: 'full',
    docRoot,
    defaultBranch: 'main',
    stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
    verify: ['true'],
    authMode: 'api_key',
    gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
    attemptBudget: 3,
    usageBudget: { usd: 20 },
    trackRuntime: false,
  };
}

const config = () => configFor(DOCS);
const green: VerifyRunner = () => ({ kind: 'green', ran: ['true'] });

function srs(version: string, body = '## 1. Overview'): string {
  return [
    '# Software Requirements Specification',
    '',
    `Version ${version} · 2026-08-21`,
    '',
    '| Version | Date | Change |',
    '|---|---|---|',
    `| ${version} | 2026-08-21 | a change |`,
    '',
    body,
    '',
  ].join('\n');
}

function marker(overrides: Partial<StateMarker> = {}): StateMarker {
  return {
    state: 'CLOSING',
    tourId: 'tour-5',
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: 'closed',
    headCommit: null,
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

/** What `.git` says, which is the only thing any assertion below believes. */
function log(): string[] {
  return git('log', '--format=%s')
    .split('\n')
    .filter((line) => line !== '');
}

function headSubjectOnDisk(): string {
  return git('log', '-1', '--format=%s').trim();
}

function porcelain(): string[] {
  return git('status', '--porcelain')
    .split('\n')
    .filter((line) => line !== '');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-make-'));
  mkdirSync(wardroomPaths(root).runDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write('README.md', '# example\n');
  write(join(DOCS, 'SRS.md'), srs('1.3'));
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  writeMarker(root, marker());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the closure commit the orchestrator makes (D-112)', () => {
  it('creates the commit, and `.git` carries it', () => {
    write(join(DOCS, 'SRS.md'), srs('1.4', '## 1. Overview, settled'));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(attempt.committed).toBe(true);
    // From the repository, not from the answer: the answer is the thing under
    // test and cannot be its own evidence (D-55).
    expect(log()[0]).toBe('chore(tour-5): close the tour, closed');
    expect(attempt.hash).toBe(git('rev-parse', 'HEAD').trim());
    // Nothing of the product is left behind. `.wardroom/run/` is: the tracking
    // policy excludes it at `track_runtime: false` (D-15), and a commit that
    // swept the state marker in would put a runtime record into every commit
    // the orchestrator makes.
    expect(porcelain()).toEqual(['?? .wardroom/']);
  });

  it('leaves the runtime records out where the tracking policy excludes them (D-15)', () => {
    write(join(DOCS, 'SRS.md'), srs('1.4'));

    makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    const files = git('show', '--name-only', '--format=', 'HEAD');
    expect(files).not.toContain('.wardroom/run');
  });

  it('carries them where the policy tracks them, since the exclusion is the setting', () => {
    write(join(DOCS, 'SRS.md'), srs('1.4'));

    makeCommit({
      root,
      config: { ...config(), trackRuntime: true },
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(git('show', '--name-only', '--format=', 'HEAD')).toContain('.wardroom/run/state.json');
  });

  it('carries the whole working tree, which is what closure writes', () => {
    // Closure writes the documents, the tour log and the cleared block (§4.6
    // steps 3 to 6), and a caller enumerating paths would be a second opinion
    // about what the commit contains.
    write(join(DOCS, 'SRS.md'), srs('1.4'));
    write(join(DOCS, 'tours', 'tour-5.md'), '# Tour 5\n');

    makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    const files = git('show', '--name-only', '--format=', 'HEAD')
      .split('\n')
      .filter((line) => line !== '');
    expect(files).toContain(join(DOCS, 'SRS.md'));
    expect(files).toContain(join(DOCS, 'tours', 'tour-5.md'));
  });

  it('runs no green definition at a closure, so an abandoned tour can close', () => {
    let ran = 0;
    write(join(DOCS, 'SRS.md'), srs('1.4'));
    writeMarker(root, marker({ disposition: 'abandoned' }));

    makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'abandoned' },
      message: 'chore(tour-5): close the tour, abandoned',
      runVerification: () => {
        ran += 1;
        return { kind: 'green', ran: [] };
      },
    });

    expect(ran).toBe(0);
    expect(log()).toHaveLength(2);
  });
});

describe('a refusal creates nothing and leaves the tree as it found it', () => {
  it('makes no commit where the documents do not pass FR-6.1', () => {
    // The content moved and the version did not, at the one commit that
    // carries documents.
    write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, rewritten'));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.hash).toBeNull();
    expect(attempt.blocks.join('\n')).toContain('SRS.md');
    expect(log()).toEqual(['initial commit']);
  });

  it('unstages what it staged, so no later `git add` sweeps a refused set in', () => {
    write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, rewritten'));

    makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    // The change is still there, and still not staged: nothing was lost and
    // nothing is armed.
    expect(git('diff', '--cached', '--name-only').trim()).toBe('');
    expect(porcelain().join('\n')).toContain('SRS.md');
    expect(readFileSync(join(root, DOCS, 'SRS.md'), 'utf8')).toContain('rewritten');
  });

  it('refuses an empty staged set rather than making an empty commit', () => {
    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.blocks.join('\n')).toMatch(/nothing is staged/);
    expect(log()).toEqual(['initial commit']);
  });
});

describe('the occasion is checked against the marker, whoever names it (D-115)', () => {
  it('refuses a closure commit the marker says is a job boundary', () => {
    write('src/thing.ts', 'export const thing = 1;\n');
    writeMarker(root, marker({ state: 'EXECUTING', jobIndex: 2, disposition: null }));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.blocks.join('\n')).toMatch(/D-115/);
    expect(log()).toEqual(['initial commit']);
  });

  it('refuses a boundary commit the marker says is a closure', () => {
    write('src/thing.ts', 'export const thing = 1;\n');

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'job-boundary', tourId: 'tour-5', jobIndex: 2 },
      message: 'feat: job 2',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.blocks.join('\n')).toMatch(/job-boundary/);
    expect(attempt.blocks.join('\n')).toMatch(/closure/);
    expect(log()).toEqual(['initial commit']);
  });

  it('accepts a boundary commit the marker agrees with', () => {
    write('src/thing.ts', 'export const thing = 1;\n');
    writeMarker(root, marker({ state: 'EXECUTING', jobIndex: 2, disposition: null }));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'job-boundary', tourId: 'tour-5', jobIndex: 2 },
      message: 'feat: job 2',
      runVerification: green,
    });

    expect(attempt.committed).toBe(true);
    expect(log()[0]).toBe('feat: job 2');
  });

  it('refuses a boundary commit naming a job the marker is not at', () => {
    write('src/thing.ts', 'export const thing = 1;\n');
    writeMarker(root, marker({ state: 'EXECUTING', jobIndex: 2, disposition: null }));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'job-boundary', tourId: 'tour-5', jobIndex: 5 },
      message: 'feat: job 5',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.blocks.join('\n')).toMatch(/job 5/);
    expect(attempt.blocks.join('\n')).toMatch(/job 2/);
  });
});

describe('the WIP commit the orchestrator makes (FR-7.1, D-110, D-112)', () => {
  it('commits unfinished work on a branch that is not the default one', () => {
    git('checkout', '-q', '-b', 'wip/tour-5');
    write('src/half.ts', 'export const half = 1;\n');
    writeMarker(root, marker({ state: 'EXECUTING', jobIndex: 3, disposition: null }));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'wip-stop', reason: 'the acceptance criterion did not pass' },
      message: 'WIP: the acceptance criterion did not pass',
      runVerification: green,
    });

    expect(attempt.committed).toBe(true);
    expect(headSubjectOnDisk()).toBe('WIP: the acceptance criterion did not pass');
  });

  it('is refused on the default branch, where unfinished work looks finished', () => {
    write('src/half.ts', 'export const half = 1;\n');
    writeMarker(root, marker({ state: 'EXECUTING', jobIndex: 3, disposition: null }));

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'wip-stop', reason: 'the acceptance criterion did not pass' },
      message: 'WIP: the acceptance criterion did not pass',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.blocks.join('\n')).toContain('default_branch');
    expect(log()).toEqual(['initial commit']);
  });

  it('needs no readable marker, because the marker cannot confirm a stop', () => {
    // D-110: nothing in the marker changes when a stop condition ends a tour,
    // so the marker cannot refuse one either. Declining the commit that saves
    // unfinished work because the record of where we are is unreadable would
    // discard work at the moment things have already gone wrong.
    git('checkout', '-q', '-b', 'wip/tour-5');
    write('src/half.ts', 'export const half = 1;\n');
    writeFileSync(wardroomPaths(root).stateFile, '{ truncated');

    const attempt = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 3' },
      message: 'WIP: context ceiling reached mid job 3',
      runVerification: green,
    });

    expect(attempt.committed).toBe(true);
    expect(headSubjectOnDisk()).toMatch(/^WIP:/);
  });

  it('is refused a second time, so a stop produces one commit and not a series', () => {
    git('checkout', '-q', '-b', 'wip/tour-5');
    write('src/half.ts', 'export const half = 1;\n');
    writeMarker(root, marker({ state: 'EXECUTING', jobIndex: 3, disposition: null }));
    const first = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'wip-stop', reason: 'first stop' },
      message: 'WIP: first stop',
      runVerification: green,
    });
    expect(first.committed).toBe(true);

    write('src/half.ts', 'export const half = 2;\n');
    const second = makeCommit({
      root,
      config: config(),
      occasion: { kind: 'wip-stop', reason: 'second stop' },
      message: 'WIP: second stop',
      runVerification: green,
    });

    expect(second.committed).toBe(false);
    expect(second.blocks.join('\n')).toMatch(/one WIP/i);
    expect(log().filter((subject) => subject.startsWith('WIP:'))).toHaveLength(1);
  });
});

describe('the baseline the closure commit is checked against', () => {
  it('catches an unbumped document against the recorded baseline (D-30)', () => {
    // A document root git does not yet carry: the baseline record is the only
    // thing an unbumped change can be caught by, since the version inside the
    // document is the only other version available and would compare equal to
    // itself. `git add -A` stages it, so it does reach the staged set.
    const untracked = configFor('internal/docs');
    write(join('internal', 'docs', 'SRS.md'), srs('1.3'));
    recordClosureBaseline(root, untracked);
    write(join('internal', 'docs', 'SRS.md'), srs('1.3', '## 1. Overview, moved'));

    const attempt = makeCommit({
      root,
      config: untracked,
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(attempt.committed).toBe(false);
    expect(attempt.blocks.join('\n')).toContain('SRS.md');
  });

  it('checks nothing where the document root is ignored, which is a gap and not a pass', () => {
    // This repository's own shape (D-8), and a defect in §4.5 rather than in
    // this code. The section scopes the check to "the staged set", and an
    // ignored document root never reaches one, so `doc-baseline.json` cannot
    // be consulted for the case D-30 invented it for. The verdict says `none`,
    // which is the honest answer for a check that had nothing to check, and
    // that is what makes the gap visible here rather than reading as clean.
    const ignored = configFor('internal/docs');
    write(join('internal', 'docs', 'SRS.md'), srs('1.3'));
    write('.gitignore', '/internal/\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'ignore the document root');
    recordClosureBaseline(root, ignored);
    write(join('internal', 'docs', 'SRS.md'), srs('1.3', '## 1. Overview, moved'));
    write('src/thing.ts', 'export const thing = 1;\n');

    const attempt = makeCommit({
      root,
      config: ignored,
      occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
      message: 'chore(tour-5): close the tour, closed',
      runVerification: green,
    });

    expect(attempt.committed).toBe(true);
    expect(attempt.blocks).toEqual([]);
  });
});
