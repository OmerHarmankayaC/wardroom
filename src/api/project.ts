import type { ClosureOccasion } from '../commit/gate.js';
import { loadConfig } from '../config/load.js';
import type { ProjectConfig } from '../config/schema.js';
import type { Notifier } from '../gates/notify.js';
import { createDriverSessions } from '../loop/driver-sessions.js';
import { type RunOutcome, type WipStop, runCycle } from '../loop/run.js';
import { createSessionWiring, markerOnDisk } from '../loop/wiring.js';
import type { QueryFn } from '../roles/assembly.js';
import { type TourState, readMarker } from '../state/marker.js';
import { requestStop } from '../state/stop-request.js';
import type { VerifyRunner } from '../verify/run.js';
import { appendInbox } from './inbox.js';
import type { InboxLine } from './inbox.js';

/**
 * The project operations (SDD §5.1, FR-1.1, FR-1.2, FR-1.5, FR-5.2).
 *
 * Surface agnostic: every one takes a project path, none of them writes to a
 * terminal, and none of them holds state between calls. A surface is a thin
 * client over this and has no operation of its own (FR-5.1), which is why the
 * CLI (§5.2) can be mechanical and why the graphical and messaging surfaces
 * that follow add no capability by existing.
 *
 * `project.kickoff` is deliberately absent. SDD §4.7 records that kickoff has
 * no procedure section yet, so there is nothing here to implement it from, and
 * a function that refused every call would be a fiction with a name. It is
 * reported as a gap rather than filled.
 */

export interface RunInput {
  /**
   * The one SDK seam (D-85). Required, not defaulted: a default would let a
   * path reach the live API by nobody remembering to override it, and a
   * criterion that needs a paid call is a criterion that quietly stops being
   * checked.
   *
   * §5.1 writes this operation as `project.run(path)` and says nothing about
   * the seam. The signature here carries it because the alternative is the
   * default D-85 forbids; the table's signature is reported as a debt.
   */
  readonly query: QueryFn;
  /** Where FR-3.3's parking notification goes. Absent is a surface that cannot be reached. */
  readonly notify?: Notifier;
  /** The green definition run. Absent, the project's own commands are run for real. */
  readonly runVerification?: VerifyRunner;
  /** Makes the single WIP commit a stop condition ends with (FR-7.1). */
  readonly commitWip?: (stop: WipStop) => Promise<void> | void;
  /** Makes the one commit a closure ends with (§4.6 step 7, D-76). */
  readonly commitClosure?: (occasion: ClosureOccasion) => Promise<void> | void;
  readonly now?: () => Date;
}

/**
 * Starts or resumes the orchestration loop (FR-1.1, FR-1.2).
 *
 * One invocation drives one cycle: from `IDLE` through planning, execution,
 * verification and closure, and back to `IDLE`, where it returns rather than
 * planning the next tour (D-83). The other three exits are §3.2's: `GATED`
 * blocks, `PARKED` returns with a non-error status, and a stop condition ends
 * the tour with a WIP commit.
 *
 * This assembles and returns; it decides nothing. Every transition goes
 * through the machine, which is the marker's one writer (D-47), and the
 * sessions come from the wiring, which is the only thing that touches the SDK.
 */
export async function projectRun(root: string, input: RunInput): Promise<RunOutcome> {
  const config = loadConfig(root);
  const wiring = createSessionWiring({
    root,
    config,
    query: input.query,
    marker: () => markerOnDisk(root),
    ...(input.notify === undefined ? {} : { notify: input.notify }),
    ...(input.runVerification === undefined ? {} : { runVerification: input.runVerification }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return await runCycle({
    root,
    sessions: createDriverSessions({ root, config, wiring }),
    ...(input.commitWip === undefined ? {} : { commitWip: input.commitWip }),
    ...(input.commitClosure === undefined ? {} : { commitClosure: input.commitClosure }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

/**
 * The states a run is inside, as far as the marker can say (SDD §3.2).
 *
 * A run is blocked on a gate in `GATED`, so that state is here; `PARKED` means
 * the run already exited (§3.2), so it is not. `IDLE` is a closed boundary
 * with nothing driving it.
 *
 * The marker cannot prove a process is alive: a run that died leaves these
 * same states behind, which is the whole reason §4.4 exists. So this answers
 * what the record says and never claims more, and {@link projectDetach} says
 * which of the two it is reporting.
 */
const STATES_A_RUN_IS_INSIDE: readonly TourState[] = [
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
  'CLOSING',
  'FAILED',
  'GATED',
];

export type DetachResult =
  | {
      readonly kind: 'requested';
      /** The state the record says the loop is in, for the surface to report. */
      readonly state: TourState;
    }
  | {
      /** Nothing to ask: no run is inside a state a stop could be honoured from. */
      readonly kind: 'nothing-running';
      readonly reason: string;
    };

/**
 * Asks the loop to stop at the next job boundary (FR-1.2, D-83, D-106).
 *
 * A cooperative stop, never a kill. The boundary is the only place where
 * stopping costs nothing: the work is committed, the marker is current, and
 * `run` resumes from it by the ordinary resumption path (§4.4). A detach mid
 * job would discard exactly the work a boundary exists to protect.
 *
 * The request is a file. `run` holds the terminal, so `detach` is a second
 * process, and a second process cannot call into the first: no signal, no
 * socket, no pid, because durable state lives in repository files (TD-3) and a
 * request that survives a crash is the same request a boundary honours.
 *
 * Where no loop is running it says so rather than leaving the file behind. It
 * says so from the marker, which is a record and not a liveness check: a run
 * that died leaves the same states a live one does. What it prevents is the
 * obvious half of the failure, a request written against a project sitting at
 * a closed boundary with nothing that will ever read it.
 */
export function projectDetach(root: string): DetachResult {
  const marker = readMarker(root);
  if (marker.kind !== 'ok') {
    return {
      kind: 'nothing-running',
      reason:
        marker.kind === 'absent'
          ? 'this project has no state marker, so it has never been run and nothing is inside a state a stop could be honoured from (SDD §4.4 step 1).'
          : `the state marker cannot be read (${marker.reason}), so nothing can be said about what is running. Resolve that before asking for a stop (SDD §4.4 step 1, D-20).`,
    };
  }

  const { state } = marker.marker;
  if (!STATES_A_RUN_IS_INSIDE.includes(state)) {
    return {
      kind: 'nothing-running',
      reason: `the marker reads ${state}, which no run is inside, so a stop request would sit unread until some later run found it (SDD §5.1, D-106).`,
    };
  }

  requestStop(root);
  return { kind: 'requested', state };
}

/**
 * Gives the running roles owner context outside a gate (FR-5.2, D-108).
 *
 * It appends and returns; it never reaches a session directly, because almost
 * always there is no session to reach. The next session of any role opens with
 * every undelivered line in its prompt.
 *
 * An injection is context and not a decision in the TD-2 sense: it releases no
 * gate, and where the owner means to decide something gate shaped,
 * `gate.decide` is the operation.
 */
export function decisionInject(
  root: string,
  text: string,
  options: { readonly now?: Date } = {},
): InboxLine {
  const line: InboxLine = {
    text,
    writtenAt: (options.now ?? new Date()).toISOString(),
    deliveredAt: null,
  };
  appendInbox(root, line);
  return line;
}

/**
 * The project contract, including the green definition (FR-1.5, D-13).
 *
 * Returned whole rather than summarised. `verify` has one home, this file, and
 * an operation that reported a digest of it would be a second statement of
 * what green means for a reader to disagree with.
 */
export function configShow(root: string): ProjectConfig {
  return loadConfig(root);
}
