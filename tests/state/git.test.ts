import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { currentBranch, isWorkingTreeDirty, workingTreeChanges } from '../../src/state/git.js';

/**
 * The repository probes the resume procedure and the dirty-tree gate read the
 * tree through (SDD §4.4 step 3, §3.1, D-36).
 *
 * These are the questions Wardroom asks git about a repository it did not set
 * up, on a machine it does not own. A probe whose answer depends on the
 * owner's git configuration is a probe that reports whatever that machine
 * happens to be configured to say, which is not the same as reporting the
 * tree.
 */

let root: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-git-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('workingTreeChanges', () => {
  it('reports an untracked file', () => {
    write('notes.txt', 'a note\n');

    expect(workingTreeChanges(root)).toEqual([{ path: 'notes.txt', changeType: 'untracked' }]);
  });

  it('reports untracked files even where the repository is configured to hide them', () => {
    // `status.showUntrackedFiles = no` is an ordinary setting on a large
    // repository, and `--porcelain` fixes the output format, not which files
    // are selected. Without an explicit mode the probe inherits the setting
    // and reports a tree with uncommitted work in it as clean, so the gate
    // that exists to stop a tour opening over the owner's work never fires
    // and the tour's first commit sweeps it in (FR-1.6, D-36).
    git('config', 'status.showUntrackedFiles', 'no');
    write('notes.txt', 'a note\n');

    expect(workingTreeChanges(root)).toEqual([{ path: 'notes.txt', changeType: 'untracked' }]);
    expect(isWorkingTreeDirty(root)).toBe(true);
  });

  it('reports a modification even where the repository hides untracked files', () => {
    git('config', 'status.showUntrackedFiles', 'no');
    write('tracked.txt', 'one\n');
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'add tracked');
    write('tracked.txt', 'two\n');

    expect(workingTreeChanges(root)).toEqual([{ path: 'tracked.txt', changeType: 'modified' }]);
  });

  it('is empty on a clean tree, which is a fact and not a hidden change', () => {
    write('tracked.txt', 'one\n');
    git('add', 'tracked.txt');
    git('commit', '-q', '-m', 'add tracked');

    expect(workingTreeChanges(root)).toEqual([]);
    expect(isWorkingTreeDirty(root)).toBe(false);
  });
});

describe('currentBranch', () => {
  it('names the branch on an ordinary repository', () => {
    write('a.txt', 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');

    expect(currentBranch(root)).toBe('main');
  });

  it('names a branch that has no commit yet', () => {
    // A branch created for a WIP stop is unborn until that stop commits, and
    // it is exactly then that the commit gate asks which branch this is. The
    // answer must be the branch, not the sentinel that means detached: a WIP
    // commit on a legal branch would otherwise be refused for being nowhere.
    const unborn = mkdtempSync(join(tmpdir(), 'wardroom-unborn-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'wip/tour-1', unborn], { stdio: 'ignore' });

      expect(currentBranch(unborn)).toBe('wip/tour-1');
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });

  it('is null on a detached HEAD, which is not a branch', () => {
    write('a.txt', 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    git('checkout', '-q', '--detach');

    expect(currentBranch(root)).toBeNull();
  });
});
