import { execFileSync } from 'node:child_process';

/**
 * The repository facts the resume procedure validates the marker against
 * (SDD §4.4 step 2 and step 3). Where marker and repository disagree, the
 * repository wins: it is the evidence, the marker is the record.
 */

export class NotARepositoryError extends Error {
  constructor(root: string) {
    super(`${root} is not a git repository; Wardroom manages one repository per project.`);
    this.name = 'NotARepositoryError';
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function assertRepository(root: string): void {
  try {
    git(root, ['rev-parse', '--git-dir']);
  } catch {
    throw new NotARepositoryError(root);
  }
}

/** The current commit, or null in a repository that has none yet. */
export function headCommit(root: string): string | null {
  assertRepository(root);
  try {
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    return null;
  }
}

/** The five change types the dirty-tree preview names (SDD §3.1, D-36). */
export const TREE_CHANGE_TYPES = ['modified', 'added', 'deleted', 'renamed', 'untracked'] as const;
export type TreeChangeType = (typeof TREE_CHANGE_TYPES)[number];

/** One changed path in the working tree, under the path it now has. */
export interface TreeChange {
  readonly path: string;
  readonly changeType: TreeChangeType;
}

/** The D-36 vocabulary for one porcelain status column. */
function changeTypeFor(x: string, y: string): TreeChangeType {
  if (x === '?' || y === '?') return 'untracked';
  if (x === 'R' || y === 'R') return 'renamed';
  if (x === 'D' || y === 'D') return 'deleted';
  if (x === 'A' || y === 'A' || x === 'C' || y === 'C') return 'added';
  return 'modified';
}

/**
 * Every uncommitted change in the working tree, tracked or not, each with its
 * change type (SDD §3.1, D-36). This is the one scan: the cleanliness probe
 * below derives from it, so resume and the dirty-tree gate can never judge
 * the same tree differently.
 *
 * `.wardroom/run/` is excluded (D-23). Runtime records are the orchestrator's
 * own bookkeeping, written at exactly the boundaries this scan runs at;
 * counting them would make every tree look dirty at every look, and a signal
 * that always fires carries the same information as one that never does.
 */
export function workingTreeChanges(root: string): readonly TreeChange[] {
  assertRepository(root);
  // -z: NUL separators and unquoted paths. A rename entry is the new path
  // followed by the original as its own token, so the original is consumed
  // alongside it and the change is reported once, under the path it now has.
  // `--untracked-files=normal` is stated rather than left to configuration.
  // `--porcelain` fixes the output format, not which files are selected, so a
  // repository or machine carrying `status.showUntrackedFiles = no` would
  // otherwise hand back a tree with uncommitted work in it as clean, and the
  // gate that exists to stop a tour opening over the owner's work would never
  // fire (FR-1.6, D-36). A probe must report the tree, not the setting.
  const output = git(root, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=normal',
    '--',
    ':(exclude).wardroom/run',
  ]);
  const tokens = output.split('\0').filter((token) => token !== '');

  const changes: TreeChange[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    const x = token.charAt(0);
    const y = token.charAt(1);
    changes.push({ path: token.slice(3), changeType: changeTypeFor(x, y) });
    // A rename or copy entry carries the source path as a second token. It is
    // consumed here, not mapped by changeTypeFor, because a copy reports as
    // `added` while still carrying the extra token: keying the skip off the
    // reported type would misread the source path as its own entry.
    if (x === 'R' || y === 'R' || x === 'C' || y === 'C') index += 1;
  }
  return changes;
}

/**
 * Whether the working tree carries uncommitted work, tracked or not.
 * A dirty tree is how death mid-job announces itself (SDD §4.4 step 3).
 */
export function isWorkingTreeDirty(root: string): boolean {
  return workingTreeChanges(root).length > 0;
}

/**
 * Whether git tracks anything at this path. A directory answers for its
 * contents, which is how the commit gate learns whether the document root is
 * tracked and therefore whether git can supply a baseline at all
 * (SDD §4.5, BACKLOG D-30).
 */
export function isPathTracked(root: string, path: string): boolean {
  assertRepository(root);
  try {
    return git(root, ['ls-files', '--', path]).trim() !== '';
  } catch {
    return false;
  }
}

/** The file as committed at HEAD, or null where HEAD does not carry it. */
export function fileAtHead(root: string, path: string): string | null {
  assertRepository(root);
  try {
    return git(root, ['show', `HEAD:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The current branch name, or null on a detached HEAD.
 *
 * `symbolic-ref` reads what HEAD points at, which is a question a branch with
 * no commit on it can still answer. `rev-parse --abbrev-ref HEAD` cannot: it
 * resolves HEAD to a commit first and fails on an unborn branch, which made
 * a freshly created branch indistinguishable from a detached HEAD. That
 * mattered exactly where this is asked, at a WIP stop on a branch created for
 * it, whose first commit is the stop itself (FR-7.1, D-33).
 */
export function currentBranch(root: string): string | null {
  assertRepository(root);
  try {
    return git(root, ['symbolic-ref', '--short', 'HEAD']).trim();
  } catch {
    // HEAD is not a symbolic ref: it names a commit directly, which is what a
    // detached HEAD is.
    return null;
  }
}

/** The subject line of the commit at HEAD, or null in a repository with none. */
export function headSubject(root: string): string | null {
  assertRepository(root);
  try {
    return git(root, ['log', '-1', '--format=%s']).trim();
  } catch {
    return null;
  }
}

/**
 * Repository-relative paths in the staged set (SDD §4.5).
 *
 * Read from the repository rather than from the call that asked to commit: a
 * commit message says nothing about what is staged, and a check that trusted
 * the committer's account of its own staged set would be the defect D-55
 * names, one level down from the green claim D-58 removes.
 *
 * `-z` because a path may contain anything, newlines included, and the
 * newline-separated form quotes those paths into a shape nobody unquotes
 * correctly the first time.
 */
export function stagedPaths(root: string): string[] {
  assertRepository(root);
  const listing = git(root, ['diff', '--cached', '--name-only', '-z']);
  return listing.split('\0').filter((path) => path !== '');
}
