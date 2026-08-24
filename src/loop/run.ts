import { WIP_SUBJECT_PREFIX } from '../commit/gate.js';
import { loadConfig } from '../config/load.js';
import type { ProjectConfig } from '../config/schema.js';
import { dirtyTreeGateRequest } from '../gates/dirty-tree.js';
import { enqueue } from '../gates/queue.js';
import { readEntry } from '../gates/store.js';
import { type TreeChange, workingTreeChanges } from '../state/git.js';
import { advance } from '../state/machine.js';
import type { StateMarker, TourDisposition, TourState } from '../state/marker.js';
import { resume } from '../state/resume.js';
import { type ClosingSession, driveClosing } from './closing.js';
import { type ImplementerSession, driveExecuting } from './executing.js';
import { type PmSession, drivePlanning } from './planning.js';
import { driveFailed, driveVerifying } from './verifying.js';

/**
 * The run cycle (SDD §5.1, §3.2, D-83).
 *
 * One invocation drives one cycle: it reads the marker from disk, calls the
 * driver that state names, and carries the tour from `IDLE` back to `IDLE`,
 * where it returns rather than planning the next tour. Continuing
 * automatically would spend the next tour's budget before the owner had seen
 * the last one close, which is the same trade FR-3.4 makes everywhere else.
 *
 * The other three exits are the ones §3.2 already defines: `GATED` blocks,
 * `PARKED` returns with a non-error status, and a stop condition ends the tour
 * with a WIP commit.
 *
 * What this module does NOT do, deliberately:
 * - It does not decide transitions. Every one goes through the machine, which
 *   is the marker's one writer (D-47); the loop chooses events, not states.
 * - It does not build sessions. They are injected, for the same reason the
 *   drivers take them: a session is a live SDK query against an account.
 * - It does not run git. The dirty-tree scan is a read; the WIP commit is
 *   handed to the caller, whose commit is gated by §4.5.
 */

/** The three sessions a cycle can need, one per role-bearing state. */
export interface RunSessions {
  readonly pm: PmSession;
  readonly implementer: ImplementerSession;
  readonly closing: ClosingSession;
}

/** What the caller is asked to commit when a stop condition ends the tour. */
export interface WipStop {
  /** Why the tour is stopping with work unfinished (§4.5 requires it stated). */
  readonly reason: string;
  /** The subject line, carrying the prefix a second WIP stop is caught by. */
  readonly message: string;
  /** The uncommitted work at the moment of the stop, which may be nothing. */
  readonly changes: readonly TreeChange[];
}

export interface RunCycleInput {
  readonly root: string;
  readonly sessions: RunSessions;
  /**
   * Whether the run has been asked to stop (D-83). Asked once at each job
   * boundary and nowhere else: a detach mid-job would discard exactly the work
   * a boundary exists to protect.
   */
  readonly stopRequested?: () => boolean;
  /**
   * Makes the single WIP commit a stop condition ends with (FR-7.1's second
   * occasion). Absent, the stop still happens and reports that no commit was
   * made, rather than reporting a commit that did not happen.
   */
  readonly commitWip?: (stop: WipStop) => Promise<void> | void;
  readonly now?: () => Date;
}

/**
 * How the cycle ended.
 *
 * One record rather than a discriminated union: every field is meaningful for
 * every ending, and the fields that do not apply are null rather than absent,
 * so a caller reading `wipCommitted` on an ending that made no commit is told
 * `false` instead of `undefined`.
 */
export interface RunOutcome {
  readonly kind: 'idle' | 'gated' | 'parked' | 'detached' | 'stopped' | 'exited';
  /** The marker as the cycle left it, or null where none could be established. */
  readonly marker: StateMarker | null;
  /** The states this invocation passed through, in order. */
  readonly visited: readonly TourState[];
  /** The gate the cycle is waiting on, or null. */
  readonly gateId: string | null;
  /** Why the cycle ended, where the ending is not simply the tour closing. */
  readonly reason: string | null;
  /** The failure that stopped the cycle, or null. Never thrown past here. */
  readonly error: Error | null;
  /** Whether the WIP commit a stop condition calls for was actually made. */
  readonly wipCommitted: boolean;
  /** The disposition a closed tour recorded, or null where none closed. */
  readonly disposition: TourDisposition | null;
}

/**
 * A ceiling on how many states one cycle may pass through, independent of the
 * transitions themselves.
 *
 * Every exit below depends on a driver moving the state, and a driver that
 * stops moving it turns this into a spin with nothing on disk saying why. Set
 * far above any real cycle: the longest legitimate path is a handful of states
 * plus the retries the attempt budget already bounds.
 */
const MAX_STATES_PER_CYCLE = 64;

function outcome(partial: Partial<RunOutcome> & Pick<RunOutcome, 'kind'>): RunOutcome {
  return {
    marker: null,
    visited: [],
    gateId: null,
    reason: null,
    error: null,
    wipCommitted: false,
    disposition: null,
    ...partial,
  };
}

export async function runCycle(input: RunCycleInput): Promise<RunOutcome> {
  const { root } = input;
  const config: ProjectConfig = loadConfig(root);
  const now = input.now ?? (() => new Date());
  const rules = { attemptBudget: config.attemptBudget };
  const visited: TourState[] = [];

  // Resumption first, always. The marker is a hint and §4.4 is what turns it
  // into a state, so a cycle that read the marker directly would be a second
  // resumption procedure with its own opinion about a stale HEAD.
  const start = resume(root, now());
  if (start.state === null || start.marker === null) {
    return outcome({
      kind: 'stopped',
      visited,
      reason:
        'the marker was unreadable and the repository alone cannot say what state the tour is in, so no driver can be named (SDD §4.4). Nothing is guessed at, and nothing was committed.',
    });
  }

  let marker: StateMarker = start.marker;
  let disposition: TourDisposition | null = null;
  /** Set once the cycle has closed a tour, which is where an invocation ends. */
  let closed = false;
  /** Set where a closure had to assume its disposition, so the caller is told. */
  let blindClosure: string | null = null;

  const stopWith = async (reason: string, error: Error | null): Promise<RunOutcome> => {
    const changes = workingTreeChanges(root);
    let wipCommitted = false;
    if (input.commitWip !== undefined) {
      await input.commitWip({
        reason,
        message: `${WIP_SUBJECT_PREFIX} ${reason}`,
        changes,
      });
      wipCommitted = true;
    }
    return outcome({ kind: 'stopped', marker, visited, reason, error, wipCommitted });
  };

  for (let step = 0; ; step += 1) {
    if (step > MAX_STATES_PER_CYCLE) {
      return await stopWith(
        `the cycle passed through ${step} states without reaching an exit, which is a loop that is not making progress (SDD §5.1).`,
        null,
      );
    }
    visited.push(marker.state);

    try {
      switch (marker.state) {
        case 'IDLE': {
          // The cycle ends here, whether it arrived by closing a tour or was
          // already here. One invocation is one cycle (D-83).
          if (closed) {
            return outcome({ kind: 'idle', marker, visited, disposition, reason: blindClosure });
          }

          // FR-1.6: a tour never opens over the owner's uncommitted work
          // without being told to. The scan is the same one §4.4 step 3 uses,
          // so the gate and resumption can never judge one tree differently.
          const changes = workingTreeChanges(root);
          if (changes.length > 0) {
            const entry = enqueue(root, dirtyTreeGateRequest(changes));
            marker = advance(
              root,
              marker,
              { type: 'raise-gate', gateClass: 'dirty-tree', gateId: entry.gateId },
              rules,
              now(),
            ).marker;
            continue;
          }

          marker = advance(root, marker, { type: 'open' }, rules, now()).marker;
          continue;
        }

        case 'PLANNING': {
          const result = await drivePlanning({
            root,
            config,
            marker,
            session: input.sessions.pm,
            now,
          });
          marker = result.marker;
          continue;
        }

        case 'EXECUTING': {
          const result = await driveExecuting({
            root,
            config,
            marker,
            session: input.sessions.implementer,
            ...(input.stopRequested === undefined ? {} : { stopRequested: input.stopRequested }),
            now,
          });
          marker = result.marker;
          if (result.stopped) {
            // The tour stays open at the boundary it reached. Nothing to
            // commit and nothing to close: the next run picks it up by the
            // ordinary resumption path (§4.4, §5.1).
            return outcome({
              kind: 'detached',
              marker,
              visited,
              reason: `the run was asked to stop and did so at the boundary after job ${marker.jobIndex ?? 0}, with that job committed (D-83).`,
            });
          }
          disposition = result.disposition;
          continue;
        }

        case 'VERIFYING': {
          const result = driveVerifying({ root, config, marker, now });
          marker = result.marker;
          continue;
        }

        case 'FAILED': {
          const result = driveFailed({ root, config, marker, now });
          marker = result.marker;
          continue;
        }

        case 'CLOSING': {
          // Within a cycle the disposition is known: EXECUTING computed it,
          // and a tour-budget rejection set it as the decision was applied.
          //
          // It is NOT known to a cycle that resumed straight into CLOSING,
          // because nothing on disk carries it there. §3.2 says the rejected
          // gate entry does and that resumption reconstructs it from there,
          // but the marker stops naming that entry the moment the decision is
          // applied (D-62 clears `gate_id` outside the gate-bearing states),
          // so there is nothing left to look it up by. Reported as a debt
          // rather than papered over with a scan for "the newest rejected
          // entry", which §3.3 already rules out as an identification.
          const resumedBlind = disposition === null;
          const result = await driveClosing({
            root,
            config,
            marker,
            session: input.sessions.closing,
            disposition: disposition ?? 'closed',
            now,
          });
          marker = result.marker;
          if (result.kind === 'closed') {
            disposition = result.disposition;
            closed = true;
            if (resumedBlind) {
              // Said out loud rather than left in the log's disposition line,
              // where a reader would take it for a fact somebody established.
              blindClosure =
                'this cycle resumed into CLOSING, where the disposition is not recoverable from disk, so the tour was closed as `closed`. An abandoned or carried tour that died before its closure would be recorded here as an ordinary one.';
            }
          }
          continue;
        }

        case 'GATED':
        case 'PARKED': {
          const entry = marker.gateId === null ? null : readEntry(root, marker.gateId);
          if (entry === null) {
            return await stopWith(
              `the marker reads ${marker.state} and names gate ${marker.gateId ?? 'nothing'}, which the queue does not hold. The entry is the durable record of a pending decision and outlives the process by design, so its absence is a defect elsewhere rather than a tour that was never gated (SDD §4.4 step 4).`,
              null,
            );
          }

          if (entry.status === 'pending') {
            // The orchestrator is blocked on this project (§3.2, D-14).
            // Parking is the same wait with the process released: both leave
            // the entry pending and the marker where it stands.
            return outcome({
              kind: marker.state === 'GATED' ? 'gated' : 'parked',
              marker,
              visited,
              gateId: entry.gateId,
              reason: `${entry.gateClass}: ${entry.what}`,
            });
          }

          // The owner decided, here or while the process was down; either way
          // the answer is applied from the entry, which is the record (D-38).
          const decided = advance(
            root,
            marker,
            {
              type: 'decide',
              gateClass: entry.gateClass,
              approved: entry.status === 'approved',
            },
            rules,
            now(),
          );
          marker = decided.marker;
          if (decided.exits) {
            // A rejected dirty-tree gate leaves IDLE with the tree untouched
            // and the run exits. There is no third outcome (FR-1.6).
            return outcome({
              kind: 'exited',
              marker,
              visited,
              gateId: entry.gateId,
              reason: `the ${entry.gateClass} gate was rejected, so the repository is untouched and the run exits (FR-1.6).`,
            });
          }
          if (decided.abandoned) disposition = 'abandoned';
          continue;
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return await stopWith(failure.message, failure);
    }
  }
}
