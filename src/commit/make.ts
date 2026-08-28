import type { ProjectConfig } from '../config/schema.js';
import { stagedPaths } from '../state/git.js';
import type { VerifyRunner } from '../verify/run.js';
import { type CommitOccasion, checkCommit } from './gate.js';
import { createCommit, stageAll, unstageAll } from './repository.js';

/**
 * The commit the orchestrator makes itself (SDD §4.5, D-112).
 *
 * Two of FR-7.1's three occasions have no session behind them. The closure
 * commit carries documents a PM session wrote and the block the orchestrator
 * cleared (§4.6 steps 6 and 7), and the WIP commit is made when a stop
 * condition ends a tour, which is the orchestrator's decision and not a
 * session's act. So the gate is a function with two callers rather than a hook
 * with one: the hook for the commits sessions make, and this for these two.
 *
 * The same checks run at both, which is what "every commit Wardroom makes
 * passes one check" means. This adds no check and skips none; it stages, asks,
 * and either commits or reports why it did not.
 *
 * **Why the caller names its occasion here and the hook does not.** The
 * orchestrator made the decision that produced the commit, so it knows which
 * occasion this is; the gate checks that claim against the marker and refuses
 * where they disagree (D-115). A session has no such standing and names
 * nothing.
 */

export interface CommitAttempt {
  /** Whether a commit was created. The only honest source for §4.6 step 8. */
  readonly committed: boolean;
  /** The new commit, or null where none was made. */
  readonly hash: string | null;
  /** Why not, one line per failed condition. Empty where the commit was made. */
  readonly blocks: readonly string[];
}

export interface MakeCommitInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The occasion the orchestrator says it is at, checked against the marker. */
  readonly occasion: CommitOccasion;
  /** The commit message. Its first line is the subject the WIP rule reads. */
  readonly message: string;
  /** The green definition run, injected so a test need not spend a real suite. */
  readonly runVerification?: VerifyRunner;
}

/**
 * Stages the working tree, runs the gate, and commits where it allows.
 *
 * The order matters and is the one the gate's own contract requires: the
 * staged set has to exist before the gate can read it from the repository,
 * because reading it from the caller would be the defect D-55 names. A refusal
 * therefore has staging to undo, and it undoes it: the working tree is left
 * exactly as it was found, so nothing is lost and no later `git add` sweeps a
 * refused set into a commit nobody checked.
 *
 * An empty staged set is a refusal rather than an empty commit. Closure with
 * nothing to commit means the documents, the tour log and the cleared block
 * all failed to reach the tree, and an empty commit would record a closure
 * that carried none of them.
 */
export function makeCommit(input: MakeCommitInput): CommitAttempt {
  const { root, config } = input;
  stageAll(root, config.trackRuntime);

  const staged = stagedPaths(root);
  if (staged.length === 0) {
    unstageAll(root);
    return {
      committed: false,
      hash: null,
      blocks: [
        'nothing is staged, so there is no commit to make. An empty commit would record work that is not there (SDD §4.5).',
      ],
    };
  }

  const verdict = checkCommit(
    root,
    config,
    {
      stagedPaths: staged,
      occasion: input.occasion,
      subject: input.message.split('\n')[0] ?? null,
    },
    input.runVerification === undefined ? {} : { runVerification: input.runVerification },
  );

  if (!verdict.allowed) {
    unstageAll(root);
    return { committed: false, hash: null, blocks: verdict.blocks };
  }

  return { committed: true, hash: createCommit(root, input.message), blocks: [] };
}
