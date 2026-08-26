import { type ClosureOccasion, WIP_SUBJECT_PREFIX } from '../commit/gate.js';
import { loadConfig } from '../config/load.js';
import type { ProjectConfig } from '../config/schema.js';
import { dirtyTreeGateRequest } from '../gates/dirty-tree.js';
import { parkElapsedGate } from '../gates/parking.js';
import { enqueue } from '../gates/queue.js';
import { readEntry } from '../gates/store.js';
import { type TreeChange, workingTreeChanges } from '../state/git.js';
import { advance } from '../state/machine.js';
import type { StateMarker, TourDisposition, TourState } from '../state/marker.js';
import { resume } from '../state/resume.js';
import { clearStopRequest, stopRequested } from '../state/stop-request.js';
import { driveClosing } from './closing.js';
import type { DriverSessionFactory } from './driver-sessions.js';
import { driveExecuting } from './executing.js';
import { drivePlanning } from './planning.js';
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
  /**
   * Where a session comes from, asked at every entry into a role-bearing state
   * (D-99).
   *
   * A factory rather than three ready sessions: no session spans two states,
   * and re-entering a state starts a new one, whether the re-entry is a retry
   * after `FAILED`, a resume after a park, or a second cycle. Holding three
   * sessions here would make that impossible to express, and the two mechanisms
   * that already assume it, NFR-4's attribution by state and D-61's
   * authorization, would both be quietly wrong.
   */
  readonly sessions: DriverSessionFactory;
  /**
   * Whether the run has been asked to stop (D-83, D-106). Asked once at each
   * job boundary and nowhere else: a detach mid-job would discard exactly the
   * work a boundary exists to protect.
   *
   * Absent, the run reads `run/stop-requested`, which is what `detach` writes
   * (../state/stop-request.ts). Present, the caller answers instead, which is
   * how a drive is exercised without a file. Either way the cycle clears any
   * request it finds at startup: see {@link runCycle}.
   */
  readonly stopRequested?: () => boolean;
  /**
   * Makes the single WIP commit a stop condition ends with (FR-7.1's second
   * occasion). Absent, the stop still happens and reports that no commit was
   * made, rather than reporting a commit that did not happen.
   */
  readonly commitWip?: (stop: WipStop) => Promise<void> | void;
  /**
   * Makes the one commit a closure ends with (§4.6 step 7, D-76).
   *
   * Handed on to the closing drive, which owns the order the procedure fixes:
   * the block is cleared before it and the baseline refreshed after it (D-77).
   * Absent, the tour still closes and reports that no commit was asked for.
   */
  readonly commitClosure?: (occasion: ClosureOccasion) => Promise<void> | void;
  readonly now?: () => Date;
}

/**
 * How the cycle ended.
 *
 * One record rather than a discriminated union: every field is meaningful for
 * every ending, and the fields that do not apply are null rather than absent,
 * so a caller reading `wipRequested` on an ending that asked for no commit is told
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
  /**
   * Whether the WIP commit a stop condition calls for was asked for.
   *
   * Asked for, not made. The loop runs no git: it hands the stop to the
   * caller, whose commit is gated by §4.5 and may be refused there, on a clean
   * tree or on the default branch. Reporting "committed" on the strength of
   * having called the callback would be a claim about the repository made
   * without looking at it, which is the habit §4.6 exists to correct.
   */
  readonly wipRequested: boolean;
  /** The disposition a closed tour recorded, or null where none closed. */
  readonly disposition: TourDisposition | null;
  /**
   * Whether the closure commit was asked for (§4.6 step 7).
   *
   * Asked for, not made, for the reason `wipRequested` is: the loop runs no
   * git and §4.5 may refuse the commit. False for every ending that closed no
   * tour.
   */
  readonly closureCommitRequested: boolean;
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
    wipRequested: false,
    disposition: null,
    closureCommitRequested: false,
    ...partial,
  };
}

export async function runCycle(input: RunCycleInput): Promise<RunOutcome> {
  const { root } = input;
  const config: ProjectConfig = loadConfig(root);
  const askedToStop = input.stopRequested ?? (() => stopRequested(root));

  // A stale request is the failure the file shape invites, and this is what
  // closes it: a request written before this run began was aimed at a run that
  // is already gone (D-106). Without it, a detach nobody honoured would stop
  // the next tour at its first boundary, for a reason nobody could see.
  //
  // Unconditional, even where the caller answers the question itself. The file
  // is the durable request, and a run beginning invalidates any earlier one
  // whoever is being asked about it.
  clearStopRequest(root);
  const now = input.now ?? (() => new Date());
  const rules = { attemptBudget: config.attemptBudget };
  const visited: TourState[] = [];

  // Parked is computed on reading (D-107), and a run starting is a reading.
  // Without this, a gate raised and left overnight with the terminal closed
  // would still read as `GATED` the next morning: the run would report the
  // orchestrator blocked on a wait that ran out hours ago, which is exactly
  // the case `PARKED` exists for. Before resumption, so §4.4 sees the state
  // the entry actually implies.
  parkElapsedGate(root, config, { now: now() });

  // Resumption first, always. The marker is a hint and §4.4 is what turns it
  // into a state, so a cycle that read the marker directly would be a second
  // resumption procedure with its own opinion about a stale HEAD.
  const start = resume(root, now());
  if (start.state === null || start.marker === null) {
    // Both readings, not a summary of them. The whole point of stopping is
    // that the owner sees what each record said and decides; a message that
    // said only "they disagree" would leave them opening the files by hand
    // (SDD §4.4, D-96, D-100).
    return outcome({
      kind: 'stopped',
      visited,
      reason: [
        'resumption could not establish a state and wrote nothing, so no driver can be named (SDD §4.4).',
        ...start.unresolved,
      ].join('\n  - '),
    });
  }

  let marker: StateMarker = start.marker;
  /**
   * The disposition the closed tour recorded, for the caller's outcome.
   *
   * Read off the drive that closed the tour, not plumbed through the states
   * between. Since D-101 the marker carries the verdict from the transition
   * that decided it, so nothing here has to remember it across a state: a
   * cycle that resumed into `VERIFYING` or `CLOSING` finds it on disk.
   */
  let disposition: TourDisposition | null = null;
  /** Whether the closure asked for its commit (§4.6 step 7). */
  let closureCommitRequested = false;
  /** Set once the cycle has closed a tour, which is where an invocation ends. */
  let closed = false;

  const stopWith = async (reason: string, error: Error | null): Promise<RunOutcome> => {
    const changes = workingTreeChanges(root);
    let wipRequested = false;
    if (input.commitWip !== undefined) {
      await input.commitWip({
        reason,
        message: `${WIP_SUBJECT_PREFIX} ${reason}`,
        changes,
      });
      wipRequested = true;
    }
    return outcome({ kind: 'stopped', marker, visited, reason, error, wipRequested });
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
            return outcome({
              kind: 'idle',
              marker,
              visited,
              disposition,
              closureCommitRequested,
            });
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
          const opened = input.sessions.planning();
          try {
            const result = await drivePlanning({
              root,
              config,
              marker,
              session: opened.session,
              now,
            });
            marker = result.marker;
          } finally {
            // Closed on the way out however the drive left, because a session
            // ends when its generator completes and nothing else marks it
            // (A.4). A drive that threw would otherwise leave one open.
            await opened.close();
          }
          continue;
        }

        case 'EXECUTING': {
          const tourId = marker.tourId;
          if (tourId === null) {
            return await stopWith(
              'the marker reads EXECUTING and names no tour. The identifier is minted with the open-tour block at the end of planning (SDD §3.3, §4.1 step 7, D-45), so a marker without one here is a shape the transition table never produced.',
              null,
            );
          }
          const opened = input.sessions.executing(tourId);
          let result: Awaited<ReturnType<typeof driveExecuting>>;
          try {
            result = await driveExecuting({
              root,
              config,
              marker,
              session: opened.session,
              stopRequested: askedToStop,
              now,
            });
          } finally {
            await opened.close();
          }
          marker = result.marker;
          if (result.stopped) {
            // Honoured, so the request is answered and goes (D-106). A run
            // that died between the boundary and here leaves it standing, and
            // the next run clears it at startup, which is the same rule
            // arriving one cycle later.
            clearStopRequest(root);
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
          // Nothing about the disposition passes through here since D-101: a
          // carried tour wrote its own at the boundary that decided it, and
          // `green` records `closed` where nothing else has.
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
          // The disposition is read off the marker by the drive itself (D-92).
          // It used to be passed in from this loop, which worked for a cycle
          // that ran straight through and failed for one that resumed into
          // CLOSING: nothing on disk carried it, so an abandoned or a carried
          // tour would have been written into the permanent log as an ordinary
          // one. Two of the three were unrecoverable at the moment they were
          // needed, which is what the marker field closed.
          const closingTour = marker.tourId;
          if (closingTour === null) {
            return await stopWith(
              'the marker reads CLOSING and names no tour, and a tour closing has an identifier: it was minted when its record was created (SDD §3.3, D-45).',
              null,
            );
          }
          const opened = input.sessions.closing(closingTour);
          let result: Awaited<ReturnType<typeof driveClosing>>;
          try {
            result = await driveClosing({
              root,
              config,
              marker,
              session: opened.session,
              ...(input.commitClosure === undefined ? {} : { commitClosure: input.commitClosure }),
              now,
            });
          } finally {
            await opened.close();
          }
          marker = result.marker;
          if (result.kind === 'closed') {
            disposition = result.disposition;
            closureCommitRequested = result.committed;
            closed = true;
          }
          // Where the drive raised a scope-change gate instead, the marker
          // carries the disposition through GATED and back (D-101), so
          // nothing here holds it for the return.
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
          // The disposition is not taken from `decided.abandoned`: the
          // rejection wrote it into the marker, and the closing drive reads it
          // from there. Two records of one fact is what D-92 closed.
          continue;
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      return await stopWith(failure.message, failure);
    }
  }
}
