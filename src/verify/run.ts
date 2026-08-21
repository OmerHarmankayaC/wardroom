import { spawnSync } from 'node:child_process';

/**
 * The green definition run (SDD §4.3, SRS §3.4).
 *
 * The definition lives in `config.json` as `verify` (D-13), an ordered list of
 * commands: test suite, suite in reversed file order, lint, type checks. This
 * module runs that list and answers what happened; it decides nothing about
 * what the answer means.
 *
 * **Two callers, one definition (D-58).** The commit gate runs this at every
 * job boundary before it allows a commit, because a boundary is defined as
 * green and a session's report of its own greenness is exactly the evidence
 * D-55 forbids resting on. `VERIFYING` runs the same list over the tour. Only
 * the second moves the state machine and spends the attempt budget. Neither
 * fact belongs here: a runner that knew which caller it had would be a runner
 * that could answer differently for each.
 */

export interface VerificationFailure {
  readonly command: string;
  readonly exitCode: number;
  /** Everything the command wrote, both streams, in the order it wrote them. */
  readonly output: string;
}

export type VerificationResult =
  | { readonly kind: 'green'; readonly ran: readonly string[] }
  | {
      readonly kind: 'failed';
      readonly failure: VerificationFailure;
      /** The commands that ran, ending with the one that failed. */
      readonly ran: readonly string[];
    }
  /**
   * There was nothing to run. Kept apart from `failed` because the two are
   * different facts about the project, and apart from `green` because reading
   * an empty list as "nothing failed" is the silent pass FR-1.5 prohibits.
   */
  | { readonly kind: 'no-definition'; readonly reason: string };

/** The seam the commit gate and, later, `VERIFYING` are given. */
export type VerifyRunner = (root: string, commands: readonly string[]) => VerificationResult;

/**
 * Runs each command in order in the project root; the first non-zero exit ends
 * the run (SDD §4.3).
 *
 * Commands are the project's own text and are run through a shell, because
 * that is what the contract's author wrote them for: `npm run test` and
 * `biome check .` are shell lines, not argv arrays. This is not a place where
 * quoting could smuggle anything in that the author did not already have,
 * since the author of `verify` is the author of the repository.
 *
 * An empty or absent list is a verification failure with the reason stated,
 * never a pass. Wardroom does not infer commands from the stack at
 * verification time: a guessed test command that happens to exit zero would
 * report green for a suite that never ran (FR-1.5).
 */
export function runVerification(root: string, commands: readonly string[]): VerificationResult {
  if (commands === undefined || commands.length === 0) {
    return {
      kind: 'no-definition',
      reason:
        'the project contract carries no `verify` commands, so there is nothing to run and nothing that could have passed. An empty green definition is a verification failure, never a pass (FR-1.5, SDD §4.3).',
    };
  }

  const ran: string[] = [];
  for (const command of commands) {
    ran.push(command);
    const finished = spawnSync(command, {
      cwd: root,
      shell: true,
      encoding: 'utf8',
      // Both streams together: a failing suite writes its diagnosis to one and
      // its summary to the other, and a record holding half of it is a record
      // nobody can act on.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // A command killed by a signal, or one whose shell could not start at all,
    // reports no status. Both are failures, and the second leaves no output of
    // its own: a failure whose whole evidence is an empty string is a failure
    // nobody can act on, so the spawn error is kept where the output would be.
    const exitCode = finished.status ?? 1;
    if (exitCode !== 0) {
      const spawnError = finished.error === undefined ? '' : `${finished.error.message}\n`;
      return {
        kind: 'failed',
        failure: {
          command,
          exitCode,
          output: `${spawnError}${finished.stdout ?? ''}${finished.stderr ?? ''}`,
        },
        ran,
      };
    }
  }

  return { kind: 'green', ran };
}
