import { readFileSync } from 'node:fs';
import { wardroomPaths } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';

/**
 * The tour state marker (SDD §3.3).
 *
 * The marker is a hint, not evidence: §4.4 validates it against the repository
 * before trusting it. What this module owes that procedure is a marker that is
 * either wholly present or wholly absent, and an honest answer when it is
 * neither (BACKLOG D-20).
 */

/** The eight states of SDD §3.2. Process death is deliberately not among them. */
export const TOUR_STATES = [
  'IDLE',
  'PLANNING',
  'EXECUTING',
  'VERIFYING',
  'CLOSING',
  'GATED',
  'PARKED',
  'FAILED',
] as const;
export type TourState = (typeof TOUR_STATES)[number];

/**
 * The two states that hang on a gate (SDD §3.2).
 *
 * One list, two consequences that are the same fact seen twice: a marker in one
 * of these states must carry the `interrupted_state` it returns to, and a
 * resume in one of these states has a gate entry to read (§4.4 step 4). `FAILED`
 * is cross-cutting too but is not here: it carries `attempt_count`, not an
 * interrupted state, and it waits on a verification rather than on the owner.
 */
export const GATE_BEARING_STATES: readonly TourState[] = ['GATED', 'PARKED'];

/**
 * The three dispositions a closure records, and no more (SDD §3.2).
 *
 * `abandoned` is a tour that could not go green (D-35); `carried` is one the
 * usage ceiling ended at a job boundary (D-66) and is not a failure, so it
 * must not travel the abandonment path. Stated beside the states because it is
 * the same section's fact, and the commit gate and the closure drive both read
 * it from here rather than one of them from the other.
 */
export const TOUR_DISPOSITIONS = ['closed', 'abandoned', 'carried'] as const;
export type TourDisposition = (typeof TOUR_DISPOSITIONS)[number];

/**
 * The one state that carries a disposition (SDD §3.3, D-92).
 *
 * A list of one, written as a list because `gate_id` above is the same rule
 * over two states and the two invariants are checked by the same code below. A
 * second state joining it would then arrive with its check already written,
 * which is the half that was forgotten last time.
 */
export const DISPOSITION_BEARING_STATES: readonly TourState[] = ['CLOSING'];

export interface StateMarker {
  readonly state: TourState;
  readonly tourId: string | null;
  readonly jobIndex: number | null;
  /** The state to return to once a gate is decided (SDD §3.2). */
  readonly interruptedState: TourState | null;
  /** Failed verification attempts so far, over the cycle (FR-1.3, D-60). */
  readonly attemptCount: number;
  /**
   * The gate entry this tour is waiting on (SDD §3.3, D-62). Mandatory in
   * `GATED` and `PARKED`, null everywhere else.
   *
   * The marker names it because a scan of the gates directory cannot supply
   * it: entries are never archived (D-29) so the directory accumulates, and a
   * decided entry may still carry an unconsumed authorization (D-61), so
   * neither "the pending one" nor "the newest one" identifies it.
   */
  readonly gateId: string | null;
  /**
   * Which of the three closures this is (SDD §3.3, D-92). Set on entry into
   * `CLOSING` and null in every other state.
   *
   * The state that decides the disposition writes it, which is also the
   * transition that knows it. Until this field existed only one of the three
   * was recoverable after a death: an abandoned tour carried its disposition
   * on the rejected tour-budget entry, and D-62 clears `gate_id` the moment
   * that decision is applied, so by the time closure ran there was no key left
   * to find the entry with. The tour would have closed as `closed` and the
   * tour log, which is the permanent record, would have said so. A carried
   * tour (D-66) had the same hole one route over.
   */
  readonly disposition: TourDisposition | null;
  readonly headCommit: string | null;
  readonly updatedAt: string;
}

/**
 * What a read found. `unreadable` is a distinct answer from `absent` on
 * purpose: the two mean opposite things to resumption, and collapsing them
 * silently abandons an open tour (SDD §4.4 step 1, D-20).
 */
export type MarkerRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'unreadable'; readonly reason: string }
  | { readonly kind: 'ok'; readonly marker: StateMarker };

interface OnDiskMarker {
  state: string;
  tour_id: string | null;
  job_index: number | null;
  interrupted_state: string | null;
  attempt_count: number;
  gate_id: string | null;
  disposition: string | null;
  head_commit: string | null;
  updated_at: string;
}

function toOnDisk(marker: StateMarker): OnDiskMarker {
  return {
    state: marker.state,
    tour_id: marker.tourId,
    job_index: marker.jobIndex,
    interrupted_state: marker.interruptedState,
    attempt_count: marker.attemptCount,
    gate_id: marker.gateId,
    disposition: marker.disposition,
    head_commit: marker.headCommit,
    updated_at: marker.updatedAt,
  };
}

/**
 * Writes the marker atomically (SDD §3.3, D-20). The mechanism lives in
 * ../fs/atomic.ts because gate entries need the same guarantee for the same
 * reason, and a second copy of it would be a second place to get it wrong.
 */
export function writeMarker(root: string, marker: StateMarker): void {
  const { stateFile } = wardroomPaths(root);
  atomicWriteFile(stateFile, `${JSON.stringify(toOnDisk(marker), null, 2)}\n`);
}

function isTourState(value: unknown): value is TourState {
  return typeof value === 'string' && (TOUR_STATES as readonly string[]).includes(value);
}

function isTourDisposition(value: unknown): value is TourDisposition {
  return typeof value === 'string' && (TOUR_DISPOSITIONS as readonly string[]).includes(value);
}

function isOptionalInteger(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && (value as number) >= 0);
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** Returns the schema problem with a parsed marker, or null if it holds. */
function schemaProblem(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'the marker is not a JSON object';
  }
  const record = raw as Record<string, unknown>;

  if (!isTourState(record.state)) {
    return `state must be one of ${TOUR_STATES.join(', ')}, got ${JSON.stringify(record.state)}`;
  }
  if (!isOptionalString(record.tour_id)) return 'tour_id must be a string or null';
  if (!isOptionalInteger(record.job_index)) {
    return 'job_index must be a non-negative whole number or null';
  }
  if (record.interrupted_state !== null && !isTourState(record.interrupted_state)) {
    return 'interrupted_state must name a state or be null';
  }
  if (!Number.isInteger(record.attempt_count) || (record.attempt_count as number) < 0) {
    return 'attempt_count must be a non-negative whole number';
  }
  if (!isOptionalString(record.gate_id)) return 'gate_id must be a string or null';
  if (record.disposition !== null && !isTourDisposition(record.disposition)) {
    return `disposition must be one of ${TOUR_DISPOSITIONS.join(', ')} or null`;
  }
  if (!isOptionalString(record.head_commit)) return 'head_commit must be a string or null';
  if (typeof record.updated_at !== 'string' || record.updated_at === '') {
    return 'updated_at must be a timestamp';
  }
  if (GATE_BEARING_STATES.includes(record.state) && record.interrupted_state === null) {
    return `${record.state} must carry the interrupted_state it returns to (SDD §3.2)`;
  }

  // D-62, both directions. A gate-bearing state with no identifier leaves
  // resumption with nothing to read; an identifier on any other state points
  // at an entry the tour is not waiting on, which sends resumption somewhere
  // worse than nowhere.
  const waiting = GATE_BEARING_STATES.includes(record.state);
  if (waiting && (record.gate_id === null || (record.gate_id as string).trim() === '')) {
    return `${record.state} must carry the gate_id it waits on (SDD §3.3, D-62)`;
  }
  if (!waiting && record.gate_id !== null) {
    return `gate_id is null outside ${GATE_BEARING_STATES.join(' and ')}, and ${record.state} carries ${JSON.stringify(record.gate_id)} (SDD §3.3, D-62)`;
  }

  // D-92, both directions, for the same reason D-62 is checked both ways. A
  // CLOSING marker with no disposition sends closure back to deriving one,
  // which is what left two of the three unrecoverable; a disposition on any
  // other state is a closure verdict recorded before the closure, and the next
  // entry into CLOSING would find it already answered.
  const closing = DISPOSITION_BEARING_STATES.includes(record.state);
  if (closing && record.disposition === null) {
    return `${record.state} must carry the disposition it is closing under, one of ${TOUR_DISPOSITIONS.join(', ')} (SDD §3.3, D-92)`;
  }
  if (!closing && record.disposition !== null) {
    return `disposition is null outside ${DISPOSITION_BEARING_STATES.join(' and ')}, and ${record.state} carries ${JSON.stringify(record.disposition)} (SDD §3.3, D-92)`;
  }
  return null;
}

/**
 * Reads the marker. Never throws for a marker that is merely bad: an absent
 * marker and an unreadable one are both answers the resume procedure knows
 * what to do with, and neither is an exception.
 */
export function readMarker(root: string): MarkerRead {
  const { stateFile } = wardroomPaths(root);

  let text: string;
  try {
    text = readFileSync(stateFile, 'utf8');
  } catch {
    return { kind: 'absent' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const problem = schemaProblem(raw);
  if (problem !== null) return { kind: 'unreadable', reason: problem };

  const record = raw as unknown as OnDiskMarker;
  return {
    kind: 'ok',
    marker: {
      state: record.state as TourState,
      tourId: record.tour_id,
      jobIndex: record.job_index,
      interruptedState: record.interrupted_state as TourState | null,
      attemptCount: record.attempt_count,
      gateId: record.gate_id,
      disposition: record.disposition as TourDisposition | null,
      headCommit: record.head_commit,
      updatedAt: record.updated_at,
    },
  };
}
