import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCommit } from '../../src/commit/make.js';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { readDocBaseline, recordClosureBaseline } from '../../src/documents/baseline.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';
import type { VerifyRunner } from '../../src/verify/run.js';

/**
 * The window between the closure commit and the baseline refresh (SDD §4.6
 * steps 7 and 8, §4.4's table, D-77).
 *
 * Two writes that were meant to be one act, and §4.4 already answers what a
 * death between them leaves: the next tour compares against the older
 * baseline, which is stricter rather than looser. This is the code answering
 * the same way.
 *
 * The kill is a real one in the sense that matters here: step 8 simply does
 * not run, which is what a process that died between the two would leave on
 * disk. Nothing is simulated about the commit itself, which is made for real
 * and read back from `.git` (D-55).
 */

let root: string;
const DOCS = 'internal/docs';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function config(): ProjectConfig {
  return {
    name: 'example',
    level: 'full',
    docRoot: DOCS,
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

const green: VerifyRunner = () => ({ kind: 'green', ran: ['true'] });

function srs(version: string, body: string): string {
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

function closingMarker(): StateMarker {
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
  };
}

/** One closure commit, made the way the orchestrator makes it. */
function closeTheTour() {
  return makeCommit({
    root,
    config: config(),
    occasion: { kind: 'closure', tourId: 'tour-5', disposition: 'closed' },
    message: 'chore(tour-5): close the tour, closed',
    runVerification: green,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-closure-'));
  mkdirSync(wardroomPaths(root).runDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write('README.md', '# example\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
  // A document root `HEAD` does not carry, which is what makes
  // `doc-baseline.json` the baseline (D-30). It is not ignored, so the closure
  // commit's staged set carries it and the check has something to check: see
  // the last case in this file for what happens when it is ignored.
  write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview'));
  recordClosureBaseline(root, config());
  writeMarker(root, closingMarker());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a death between the commit and the refresh leaves the older baseline', () => {
  it('leaves the commit made and the baseline where it was', () => {
    const before = readDocBaseline(root);
    write(join(DOCS, 'SRS.md'), srs('1.4', '## 1. Overview, settled'));
    write('src/thing.ts', 'export const thing = 1;\n');

    // Step 7 runs. Step 8 does not: this is the process ending here.
    const attempt = closeTheTour();

    expect(attempt.committed).toBe(true);
    // Read from `.git`, not from the attempt: the loop's account of its own
    // commit is not evidence that a commit exists (D-55).
    expect(git('log', '-1', '--format=%s').trim()).toBe('chore(tour-5): close the tour, closed');
    expect(readDocBaseline(root)).toEqual(before);
    expect(readDocBaseline(root)?.['SRS.md']?.version).toBe('1.3');
  });

  it('is stricter rather than looser, which is what §4.4 answers', () => {
    // The next tour compares against the baseline the dead process left, so a
    // document that moved without a bump is still caught. The looser direction
    // would be a refresh that happened without a commit, which would compare
    // the new documents against themselves.
    write(join(DOCS, 'SRS.md'), srs('1.4', '## 1. Overview, settled'));
    closeTheTour();

    // The next tour, moving the document again without bumping it.
    writeMarker(root, closingMarker());
    write(join(DOCS, 'SRS.md'), srs('1.4', '## 1. Overview, moved again'));
    write('src/other.ts', 'export const other = 1;\n');
    const next = closeTheTour();

    expect(next.committed).toBe(false);
    expect(next.blocks.join('\n')).toContain('SRS.md');
  });

  it('accepts the same tour again once the version moves, so the tour is not stuck', () => {
    write(join(DOCS, 'SRS.md'), srs('1.4', '## 1. Overview, settled'));
    closeTheTour();

    writeMarker(root, closingMarker());
    write(join(DOCS, 'SRS.md'), srs('1.5', '## 1. Overview, moved again'));
    write('src/other.ts', 'export const other = 1;\n');

    expect(closeTheTour().committed).toBe(true);
  });
});

describe('the refresh follows the commit and never precedes it (D-77)', () => {
  it('would pass every closure unconditionally if it ran first', () => {
    // The failure D-77 names, demonstrated rather than asserted: refresh
    // first and the gate compares the new documents against themselves.
    write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, moved without a bump'));
    recordClosureBaseline(root, config());
    write('src/thing.ts', 'export const thing = 1;\n');

    const wrongOrder = closeTheTour();

    expect(wrongOrder.committed).toBe(true);
    expect(readFileSync(join(root, DOCS, 'SRS.md'), 'utf8')).toContain('without a bump');
  });

  it('catches the same change where the refresh has not run', () => {
    // Same edit, same gate, baseline untouched: refused. The two cases differ
    // in one line, which is why the order is a rule and not a preference.
    write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, moved without a bump'));
    write('src/thing.ts', 'export const thing = 1;\n');

    const rightOrder = closeTheTour();

    expect(rightOrder.committed).toBe(false);
    expect(rightOrder.blocks.join('\n')).toContain('SRS.md');
  });
});

describe('what the check reaches, and what it does not', () => {
  it('checks nothing where the document root is ignored, which is a gap (§4.5)', () => {
    // Reported rather than worked around, and pinned here so it cannot be
    // forgotten. §4.5 scopes the version check to "the staged set", and a
    // gitignored document root never reaches one: this project's own shape
    // (D-8). So `doc-baseline.json`, which D-30 wrote for the untracked case,
    // cannot be consulted in the case it was written for.
    //
    // The verdict says `none`, which is the honest answer for a check that had
    // nothing to check, and the commit is allowed on the strength of the rest.
    write('.gitignore', '/internal/\n');
    write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, moved without a bump'));
    write('src/thing.ts', 'export const thing = 1;\n');

    const attempt = closeTheTour();

    expect(attempt.committed).toBe(true);
    expect(git('show', '--name-only', '--format=', 'HEAD')).not.toContain('SRS.md');
  });

  it('catches the same change where the root is merely uncommitted', () => {
    // The discriminating case. One line of `.gitignore` is the whole
    // difference between the check running and the check having nothing to
    // run on, which is what makes the gap above worth reporting.
    write(join(DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, moved without a bump'));
    write('src/thing.ts', 'export const thing = 1;\n');

    expect(closeTheTour().committed).toBe(false);
  });
});
