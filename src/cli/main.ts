import { UNIMPLEMENTED_OPERATIONS, operations } from '../api/operations.js';
import type { QueryFn } from '../roles/assembly.js';
import { type ParsedCommand, parseArgs } from './args.js';
import {
  renderConfig,
  renderDecision,
  renderDetach,
  renderGate,
  renderGates,
  renderLog,
  renderRun,
  renderSaid,
  renderStatus,
  renderUsage,
} from './render.js';
import { resolveProject } from './resolve.js';

/**
 * The v1 CLI (SDD §5.2, FR-5.1, D-109).
 *
 * The binding is mechanical: one command per operation, and no command that
 * reaches past the API into orchestrator internals. `operations` is the only
 * value this module imports from outside `src/cli/`, which is what makes "a
 * surface has no privileged operation" a fact a reader can check rather than
 * an intention. A CLI-only capability would be a violation of FR-5.1, not a
 * convenience.
 *
 * It writes nothing. The lines go back to the caller and the caller prints
 * them, for the same reason the operations do not print: a surface that wrote
 * to a terminal from inside the library could not be tested without one, and
 * the entry point that does the writing is three lines long.
 *
 * **Exit codes (D-109).** 0 when it did what it was asked, 1 when it failed,
 * and 2 when the project's state is what stopped it rather than an error: a
 * gate pending, a tour parked, a resumption unresolved. The third exists
 * because those are the ordinary outcomes of an orchestrator that asks before
 * it acts, and a script treating them as failures would be wrong as often as
 * it was right. `run` returning 2 with a pending gate is the system working.
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
/** The project's state stopped it, and that is not an error (D-109). */
export const EXIT_STATE = 2;

export interface CliResult {
  readonly exitCode: number;
  /** Lines for the owner. */
  readonly out: readonly string[];
  /** Lines explaining a refusal or a failure. */
  readonly err: readonly string[];
}

export interface CliDependencies {
  /** Where the owner ran the command, which the project search starts from. */
  readonly cwd: string;
  /**
   * The SDK seam `run` needs (D-85). Absent, `run` refuses rather than
   * reaching for a default: nothing in `src/` may import the SDK's runtime,
   * so the entry point supplies it and a caller that did not is told so.
   */
  readonly query?: QueryFn;
  readonly now?: () => Date;
}

function ok(out: readonly string[]): CliResult {
  return { exitCode: EXIT_OK, out, err: [] };
}

function failed(message: string): CliResult {
  return { exitCode: EXIT_FAILED, out: [], err: message.split('\n') };
}

function stateStopped(out: readonly string[]): CliResult {
  return { exitCode: EXIT_STATE, out, err: [] };
}

/**
 * How a run's ending maps onto the three codes (D-109).
 *
 * `idle` and `detached` are the command doing what it was asked: a tour closed,
 * or a run stopped where the owner told it to. Everything else that carries no
 * error is the project's state stopping it, which is the case the third code
 * exists for. Only a failure the loop caught is a failure.
 */
function runExitCode(outcome: { kind: string; error: Error | null }): number {
  if (outcome.error !== null) return EXIT_FAILED;
  return outcome.kind === 'idle' || outcome.kind === 'detached' ? EXIT_OK : EXIT_STATE;
}

async function dispatch(
  parsed: ParsedCommand,
  root: string,
  deps: CliDependencies,
): Promise<CliResult> {
  const now = deps.now?.();

  switch (parsed.command) {
    case 'init':
      // Named rather than unknown. The command exists in §5.2 and the
      // operation behind it does not exist yet, and those are different facts:
      // reporting this as an unknown command would send the owner looking for
      // a typo.
      return failed(
        `init is not available yet: ${UNIMPLEMENTED_OPERATIONS['project.kickoff'] ?? 'the operation behind it does not exist.'}`,
      );

    case 'run': {
      if (deps.query === undefined) {
        return failed(
          'run needs the SDK seam and none was supplied. Nothing inside the library imports the SDK at runtime, so the entry point provides it (BACKLOG D-85).',
        );
      }
      const outcome = await operations['project.run'](root, {
        query: deps.query,
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      return { exitCode: runExitCode(outcome), out: renderRun(outcome), err: [] };
    }

    case 'status':
      return ok(renderStatus(operations['project.status'](root, now === undefined ? {} : { now })));

    case 'gates':
      return ok(renderGates(operations['gate.list'](root, now === undefined ? {} : { now })));

    case 'gate':
      return ok(
        renderGate(
          operations['gate.show'](root, parsed.argument ?? '', now === undefined ? {} : { now }),
        ),
      );

    case 'approve':
    case 'reject':
      return ok(
        renderDecision(
          operations['gate.decide'](root, parsed.argument ?? '', {
            decision: parsed.command === 'approve' ? 'approved' : 'rejected',
            note: parsed.note,
            ...(now === undefined ? {} : { now }),
          }),
        ),
      );

    case 'say':
      return ok(
        renderSaid(
          operations['decision.inject'](
            root,
            parsed.argument ?? '',
            now === undefined ? {} : { now },
          ),
        ),
      );

    case 'usage':
      return ok(
        renderUsage(
          operations['usage.report'](root, parsed.tour === null ? {} : { tourId: parsed.tour }),
        ),
      );

    case 'log':
      return ok(renderLog(operations['history.log'](root)));

    case 'config':
      return ok(renderConfig(operations['config.show'](root)));

    case 'detach': {
      const result = operations['project.detach'](root);
      const lines = renderDetach(result);
      // Nothing running is the project's state answering, not a failure: the
      // owner asked a reasonable question and got a true answer.
      return result.kind === 'requested' ? ok(lines) : stateStopped(lines);
    }
  }
}

/**
 * Runs one command and reports what to print and what to exit with.
 *
 * It throws nothing. An operation that raises is reported as a failure with
 * its message, because a stack trace is not something the owner asked for and
 * an unhandled rejection is not an exit code.
 */
export async function runCli(argv: readonly string[], deps: CliDependencies): Promise<CliResult> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'error') return failed(parsed.message);

  const project = resolveProject(deps.cwd, parsed.parsed.project);
  if (project.kind === 'not-found') return failed(project.message);

  try {
    return await dispatch(parsed.parsed, project.root, deps);
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}
