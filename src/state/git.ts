import { execFileSync } from 'node:child_process';

/**
 * The repository facts the resume procedure validates the marker against
 * (SDD §4.4 step 2 and step 3). Where marker and repository disagree, the
 * repository wins — it is the evidence, the marker is the record.
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

/**
 * Whether the working tree carries uncommitted work, tracked or not.
 * A dirty tree is how death mid-job announces itself (SDD §4.4 step 3).
 *
 * `.wardroom/run/` is excluded. Runtime records are the orchestrator's own
 * bookkeeping, written at exactly the boundaries this check runs at; counting
 * them would make every run look like death mid-job and step 3 would fire
 * always, which is the same as never.
 */
export function isWorkingTreeDirty(root: string): boolean {
  assertRepository(root);
  const changes = git(root, ['status', '--porcelain', '--', ':(exclude).wardroom/run']);
  return changes.trim() !== '';
}
