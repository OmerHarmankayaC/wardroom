import type { Duration } from '../config/duration.js';
import type { ProjectConfig } from '../config/schema.js';
import { advance } from '../state/machine.js';
import { type StateMarker, readMarker } from '../state/marker.js';
import { park } from './queue.js';
import type { GateEntry } from './schema.js';
import { readEntry } from './store.js';

/**
 * Parked is computed on reading, never stamped by a timer (SDD §3.2, FR-3.3,
 * BACKLOG D-107).
 *
 * `gate_wait` elapsing is what parks a tour, and in a CLI-only v1 there is
 * usually nothing alive to notice the moment it elapses: `run` may have
 * exited, and there is no daemon (§1). So parked is not a stamp a live process
 * writes at the instant of expiry; it is a property of the entry, computed
 * from its enqueued time and the contract's `gate_wait` by whatever reads it
 * next, and the marker is written to `PARKED` by that reader.
 *
 * The alternative was a timer, and a timer is a process: it would make the
 * parked state depend on something having been running, so a gate raised and
 * left overnight with the terminal closed would still read as pending the next
 * morning, which is exactly the case the state exists for.
 *
 * `status`, `gates` and the next `run` all park it identically because they
 * all call this. Where a run is attached when the wait elapses it parks the
 * tour itself and prints before exiting (§5.2, ../roles/intercept.ts), which
 * is the same computation happening to have an audience.
 *
 * Parking decides nothing. The entry stays `pending` and only `parked_at` is
 * set, so a parked gate and a fresh one are answered by the owner identically
 * (D-27).
 */

/**
 * When a pending gate's waiting period runs out (FR-3.3).
 *
 * Measured from `requested_at` on the entry, which is the record, rather than
 * from when any process started waiting. A run that died and came back would
 * otherwise hand the same gate a fresh waiting period every restart, and a
 * gate that restarts often enough never parks at all. That is also what makes
 * the answer the same for every reader: the deadline is a fact about the
 * entry, so two readers cannot compute two different ones.
 */
export function parkingDeadline(entry: GateEntry, gateWait: Duration): number {
  return new Date(entry.requestedAt).getTime() + gateWait.milliseconds;
}

/** Whether this entry's waiting period has run out by the given moment. */
export function hasElapsed(entry: GateEntry, gateWait: Duration, now: Date): boolean {
  return now.getTime() >= parkingDeadline(entry, gateWait);
}

/**
 * What a reader found, and what it did about it.
 *
 * `none` carries its reason rather than being a bare false, because the
 * reasons are not interchangeable: a tour that is not gated at all, a gate
 * still inside its waiting period and an entry the queue does not hold are
 * three different facts, and a caller that collapsed them would report the
 * third as the first.
 */
export type ParkOnRead =
  | { readonly kind: 'none'; readonly reason: string }
  | {
      /** Some earlier reader already parked it; this one changed nothing. */
      readonly kind: 'already-parked';
      readonly gateId: string;
      readonly parkedAt: string;
    }
  | {
      readonly kind: 'parked';
      readonly gateId: string;
      readonly entry: GateEntry;
      readonly marker: StateMarker;
    };

export interface ParkOnReadOptions {
  /** The moment being read at. Injected so a reader can be asked about any of them. */
  readonly now?: Date;
}

/**
 * Parks the tour where its pending gate's waiting period has elapsed.
 *
 * The order is the one that survives a crash between any two steps, and it is
 * the order the attached path already uses: the entry is stamped first,
 * because it is the record and the audit line goes with it, and the marker
 * follows, so a reader that died here leaves an entry stamped and a marker a
 * later reader will move. Moving it is what the later reader does: it does not
 * stamp the entry a second time, which the queue refuses, and a refusal here
 * would leave every read of the project throwing rather than recovering.
 *
 * Only from `GATED`, and only for the gate the marker names (D-62). A pending
 * elapsed entry the marker is not waiting on belongs to no tour this could
 * park: parking on it would move a marker that was never gated, and the state
 * machine would refuse the transition anyway.
 */
export function parkElapsedGate(
  root: string,
  config: ProjectConfig,
  options: ParkOnReadOptions = {},
): ParkOnRead {
  const now = options.now ?? new Date();
  const read = readMarker(root);
  if (read.kind !== 'ok') {
    return {
      kind: 'none',
      reason: `the state marker is ${read.kind}, so nothing can be said about what this project is waiting on (SDD §4.4 step 1).`,
    };
  }

  const marker = read.marker;
  if (marker.state === 'PARKED') {
    const parked = marker.gateId === null ? null : readEntry(root, marker.gateId);
    return {
      kind: 'already-parked',
      gateId: marker.gateId ?? '',
      parkedAt: parked?.parkedAt ?? marker.updatedAt,
    };
  }

  if (marker.state !== 'GATED') {
    return { kind: 'none', reason: `the marker reads ${marker.state}, which waits on no gate.` };
  }
  if (marker.gateId === null) {
    // The marker schema forbids this shape (§3.3, D-62), so reaching it means
    // something other than the machine wrote the marker.
    return { kind: 'none', reason: 'the marker reads GATED and names no gate (SDD §3.3, D-62).' };
  }

  const entry = readEntry(root, marker.gateId);
  if (entry === null) {
    return {
      kind: 'none',
      reason: `the marker waits on gate ${marker.gateId}, which the queue does not hold.`,
    };
  }
  if (entry.status !== 'pending') {
    return {
      kind: 'none',
      reason: `gate ${entry.gateId} is already ${entry.status}; parking releases the orchestrator from a gate still waiting, and this one is answered.`,
    };
  }
  if (!hasElapsed(entry, config.gateWait, now)) {
    return {
      kind: 'none',
      reason: `gate ${entry.gateId} is still inside its waiting period, which runs out at ${new Date(parkingDeadline(entry, config.gateWait)).toISOString()}.`,
    };
  }

  // Already stamped means a reader got this far and did not finish: the entry
  // is the record and the stamp is the moment the wait actually elapsed, so it
  // is left alone and only the marker is moved. Asking the queue to stamp it
  // again is refused (../gates/queue.ts), and refusing here would make every
  // read of this project throw from then on, which is worse than the crash it
  // was recovering from.
  const parked = entry.parkedAt === null ? park(root, entry.gateId, { now }) : entry;
  // Through the machine, not built by hand. A literal here would write a shape
  // the transition table never produced, and parking from a state that had
  // never gated would go to disk without complaint. Parking decides nothing,
  // so the gate identifier travels with the state rather than being cleared by
  // it (§3.2, D-62).
  const moved = advance(
    root,
    marker,
    { type: 'park' },
    { attemptBudget: config.attemptBudget },
    now,
  ).marker;

  return { kind: 'parked', gateId: entry.gateId, entry: parked, marker: moved };
}
