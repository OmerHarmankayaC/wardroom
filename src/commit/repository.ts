import { execFileSync } from 'node:child_process';
import { RUNTIME_IGNORE_ENTRY } from '../config/tracking.js';

/**
 * The two writes the orchestrator makes to a repository (SDD §4.5, D-112).
 *
 * Kept apart from `../state/git.ts`, which is stated as the repository facts
 * resumption validates the marker against and is read-only throughout. A
 * module that both observes and mutates invites a reader to assume the wrong
 * one, and the two commits Wardroom makes itself are the only writes in the
 * system: everything else a session does goes through the tool call the hook
 * intercepts.
 *
 * Nothing here decides anything. Staging and committing happen only after the
 * gate has allowed the commit (./make.ts); this module is the hands, not the
 * judgement.
 */

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Stages every change in the working tree.
 *
 * All of it, rather than a list the caller composed. Both occasions the
 * orchestrator commits at are defined over the whole tree: closure carries the
 * documents, the tour log and the cleared block (§4.6 steps 3 to 6), and a WIP
 * stop carries whatever the tour left unfinished, which is by definition not
 * enumerable in advance. A caller passing paths would be a second opinion
 * about what the commit contains, and the gate reads the staged set from the
 * repository precisely so that no such opinion exists (D-55).
 *
 * **Except the runtime records, where the policy excludes them (D-15).** The
 * tracking policy writes a `.gitignore` entry, so in a project whose ignore
 * file is correct this changes nothing. It is stated here as well because
 * nothing has written that entry yet (§4.7 has no kickoff), and staging
 * `.wardroom/run/` would put the state marker into every commit the
 * orchestrator makes, of a directory §4.4 step 3 already excludes from tree
 * cleanliness for the same reason (D-23). One constant, one home: the path
 * comes from the policy rather than being spelled again here.
 */
export function stageAll(root: string, trackRuntime: boolean): void {
  const excluded = trackRuntime ? [] : [`:(exclude)${RUNTIME_IGNORE_ENTRY}`];
  git(root, ['add', '-A', '--', '.', ...excluded]);
}

/**
 * Creates the commit and answers with its hash.
 *
 * `--no-verify` is deliberately NOT passed: a repository's own hooks are the
 * owner's territory (§4.5), and skipping them would be Wardroom deciding
 * something about a repository it manages rather than owns.
 */
export function createCommit(root: string, message: string): string {
  git(root, ['commit', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/**
 * Undoes the staging, leaving the working tree exactly as it was.
 *
 * Called when the gate refuses. Leaving the index staged would hand the owner
 * a repository in a state Wardroom put it in and then walked away from, and
 * the next thing to run `git add` would sweep the refused set into a commit
 * that was never checked. The files themselves are untouched: `--mixed` moves
 * the index and nothing else, so no work is lost.
 */
export function unstageAll(root: string): void {
  // `reset` with no pathspec against HEAD, which is what a repository with no
  // commits yet does not have; there, an empty index is already the answer.
  try {
    git(root, ['reset', '--mixed', '--quiet', 'HEAD']);
  } catch {
    git(root, ['rm', '-r', '--cached', '--quiet', '.']);
  }
}
