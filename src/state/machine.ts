import type { GateClass } from '../gates/schema.js';
import { GATE_BEARING_STATES, type StateMarker, type TourState, writeMarker } from './marker.js';

/**
 * The tour state machine (SDD §3.2) as a pure module. Five sequential phases
 * and three cross-cutting states that remember what they interrupted; process
 * death is deliberately not a state (§4.4).
 *
 * `transition` is pure: marker in, marker out, no clock read and no disk
 * touched, so every guard is testable without a repository. `advance` is the
 * one impure wrapper: it applies a transition and writes the marker
 * atomically, because the marker is written at exactly the boundaries where
 * the process is doing something else dangerous (§3.3, D-20).
 *
 * What is NOT here, by scope: SDK sessions, the orchestration loop, gate
 * entry I/O and the CLI all belong to Tour 3-b. The machine decides what the
 * next state is; the loop makes it true in the world.
 */

export type TourEvent =
  /**
   * IDLE to PLANNING over a clean or acknowledged tree (§4.1).
   *
   * It carries no identifier. The tour record is created at the end of
   * planning and the identifier is minted there and nowhere else (§3.3, §4.1
   * step 7, D-45, D-70), so a tour in PLANNING has no name yet and inventing
   * one here would be a second minting site for a tour that may never exist.
   */
  | { readonly type: 'open' }
  /**
   * PLANNING to EXECUTING: scope written, job list handed over, and the
   * identifier minted with the open-tour block that carries it (D-45).
   */
  | { readonly type: 'plan-complete'; readonly tourId: string }
  /**
   * A job boundary inside EXECUTING: the job is done by the whole definition
   * of done and its commit exists (§4.2, FR-7.1).
   *
   * It stays in EXECUTING and moves `job_index` alone. The §3.2 table has no
   * row for it because the table is about states, and this changes none; the
   * marker nevertheless carries `job_index` and something has to move it, and
   * the orchestrator writes the marker at that boundary (D-47). Routing it
   * through the machine keeps every marker write in one place instead of
   * giving the loop a second way to write one.
   */
  | { readonly type: 'job-boundary'; readonly jobIndex: number }
  /** EXECUTING to VERIFYING: every job done and committed (§4.2). */
  | { readonly type: 'jobs-done' }
  /** VERIFYING to CLOSING: every command in the green definition passed. */
  | { readonly type: 'green' }
  /** VERIFYING to FAILED: a command failed; the output feeds the retry. */
  | { readonly type: 'verification-failed' }
  /** FAILED to EXECUTING while attempt_count is under the budget (FR-1.3). */
  | { readonly type: 'retry' }
  /**
   * Into GATED, remembering the interrupted state and the entry it waits on.
   *
   * `gateId` is required: the marker names the gate (§3.3, D-62), and a
   * transition into GATED that does not know which entry it is waiting on
   * produces a marker resumption cannot act on. No identifier is carried: a
   * gate raised at IDLE precedes the tour record, and nothing mints one there
   * (D-45, D-70).
   */
  | {
      readonly type: 'raise-gate';
      readonly gateClass: GateClass;
      readonly gateId: string;
    }
  /** GATED to PARKED: the waiting period elapsed (FR-3.3). */
  | { readonly type: 'park' }
  /**
   * The owner's decision, applied from GATED or, identically, from PARKED
   * (D-38). The class comes from the gate entry, which is the durable record;
   * the marker does not restate it (one fact, one home).
   */
  | {
      readonly type: 'decide';
      readonly gateClass: GateClass;
      readonly approved: boolean;
    }
  /** CLOSING to IDLE: log written, debts settled, open-tour block cleared. */
  | { readonly type: 'close' };

export type TourEventType = TourEvent['type'];

/** The facts the guards need. The attempt budget lives in the contract (SRS §3.1). */
export interface TransitionRules {
  readonly attemptBudget: number;
}

export interface Transition {
  readonly marker: StateMarker;
  /**
   * A tour-budget rejection routes to the abandoned closing (D-35). The
   * disposition is not in the marker: the rejected gate entry on disk already
   * carries it, and resumption reconstructs it from there (FR-1.2).
   */
  readonly abandoned: boolean;
  /** A dirty-tree rejection leaves IDLE and the run exits (FR-1.6). */
  readonly exits: boolean;
}

/**
 * What each state accepts. This is the §3.2 table's event surface; the
 * per-class and per-budget conditions are guards inside the handlers.
 */
const ACCEPTS: Record<TourState, readonly TourEventType[]> = {
  IDLE: ['open', 'raise-gate'],
  PLANNING: ['plan-complete', 'raise-gate'],
  EXECUTING: ['job-boundary', 'jobs-done', 'raise-gate'],
  VERIFYING: ['green', 'verification-failed'],
  CLOSING: ['close', 'raise-gate'],
  // A decision or a park and nothing else: the orchestrator blocks on the
  // gate it raised, so nothing exists to raise a second one (§3.2, D-14).
  GATED: ['decide', 'park'],
  PARKED: ['decide'],
  FAILED: ['retry', 'raise-gate'],
};

export class IllegalTransitionError extends Error {
  readonly state: TourState;
  readonly event: TourEventType;

  constructor(state: TourState, event: TourEventType, detail?: string) {
    super(
      `${state} does not accept ${event}${detail === undefined ? '' : ` (${detail})`}; it accepts only: ${ACCEPTS[state].join(', ')} (SDD §3.2).`,
    );
    this.name = 'IllegalTransitionError';
    this.state = state;
    this.event = event;
  }
}

function stamped(marker: StateMarker, now: Date, changes: Partial<StateMarker>): StateMarker {
  return { ...marker, ...changes, updatedAt: now.toISOString() };
}

/**
 * The shape of a tour that has just opened: named, planning, no job reached
 * yet, and a fresh attempt budget (§3.2, `attempt_count` is zero at tour
 * open). Both routes into `PLANNING` go through here, the clean-tree `open`
 * and the approval of a dirty-tree gate, so a tour opened over an
 * acknowledged tree is the same tour as one opened over a clean one.
 */
function opening(marker: StateMarker, now: Date): StateMarker {
  return stamped(marker, now, {
    state: 'PLANNING',
    // No name yet: the identifier is minted when the open-tour block is
    // written at the end of planning (§3.3, §4.1 step 7, D-45, D-70).
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
  });
}

/** The IDLE shape: no tour, no interruption, no spent attempts. */
function idle(marker: StateMarker, now: Date): StateMarker {
  return stamped(marker, now, {
    state: 'IDLE',
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
  });
}

function raiseGate(
  marker: StateMarker,
  event: Extract<TourEvent, { type: 'raise-gate' }>,
  rules: TransitionRules,
  now: Date,
): StateMarker {
  const from = marker.state;

  if (event.gateId.trim() === '') {
    throw new IllegalTransitionError(
      from,
      'raise-gate',
      'the marker names the gate_id it waits on, and a GATED marker without one leaves resumption nothing to read (SDD §3.3, D-62)',
    );
  }

  if (event.gateClass === 'dirty-tree') {
    // Only at the IDLE to PLANNING transition, with the pre-tour identity the
    // §3.2 note fixes: the id the tour will carry, job 0, IDLE to return to.
    if (from !== 'IDLE') {
      throw new IllegalTransitionError(from, 'raise-gate', 'dirty-tree is raised at IDLE only');
    }
    return stamped(marker, now, {
      state: 'GATED',
      interruptedState: 'IDLE',
      // Still nameless: the gate is a decision about the working tree, not
      // about a tour, and no tour record exists to name (§3.2, D-45, D-70).
      tourId: null,
      jobIndex: 0,
      gateId: event.gateId,
    });
  }
  if (from === 'IDLE') {
    throw new IllegalTransitionError(from, 'raise-gate', 'only dirty-tree is raised at IDLE');
  }

  if (event.gateClass === 'tour-budget') {
    // FR-1.3: the gate replaces an indefinite retry, so it exists only where
    // the budget is actually spent.
    if (from !== 'FAILED') {
      throw new IllegalTransitionError(from, 'raise-gate', 'tour-budget is raised at FAILED only');
    }
    if (marker.attemptCount < rules.attemptBudget) {
      throw new IllegalTransitionError(
        from,
        'raise-gate',
        `the attempt budget still holds (${marker.attemptCount} of ${rules.attemptBudget} spent)`,
      );
    }
  } else if (from === 'FAILED') {
    throw new IllegalTransitionError(from, 'raise-gate', 'FAILED raises only the tour-budget gate');
  }

  return stamped(marker, now, { state: 'GATED', interruptedState: from, gateId: event.gateId });
}

function decide(
  marker: StateMarker,
  event: Extract<TourEvent, { type: 'decide' }>,
  now: Date,
): Transition {
  const interrupted = marker.interruptedState;
  if (interrupted === null) {
    // The marker schema refuses this shape on read; a hand-built marker gets
    // the same answer here rather than a guessed destination.
    throw new IllegalTransitionError(
      marker.state,
      'decide',
      'the marker carries no interrupted_state to return to',
    );
  }

  if (event.gateClass === 'tour-budget') {
    if (event.approved) {
      // A fresh attempt budget: attempt_count resets and execution resumes
      // (FR-1.3).
      return {
        marker: stamped(marker, now, {
          state: 'EXECUTING',
          interruptedState: null,
          attemptCount: 0,
        }),
        abandoned: false,
        exits: false,
      };
    }
    // Rejection abandons the tour (D-35): the closing path writes the log,
    // clears the block and reaches IDLE. Returning to FAILED with the budget
    // spent would re-raise the same gate indefinitely.
    return {
      marker: stamped(marker, now, { state: 'CLOSING', interruptedState: null }),
      abandoned: true,
      exits: false,
    };
  }

  if (event.gateClass === 'dirty-tree') {
    if (event.approved) {
      // The interrupted IDLE is not returned to: approval completes the
      // transition the gate interrupted, into PLANNING over the acknowledged
      // tree (FR-1.6). The pre-tour `job_index` 0 belongs to the gate entry,
      // which is why the opening shape is taken from one place rather than
      // carried over from the marker the gate was raised on.
      return { marker: opening(marker, now), abandoned: false, exits: false };
    }
    // Rejection leaves the repository untouched and the run exits. There is
    // no third outcome (FR-1.6).
    return { marker: idle(marker, now), abandoned: false, exits: true };
  }

  // Every other class resumes the interrupted state on either answer; a
  // rejection is recorded as a new job by the loop, not by the machine
  // (§3.2). The uncommitted diff, where there is one, travels with the gate
  // (D-24).
  return {
    marker: stamped(marker, now, { state: interrupted, interruptedState: null }),
    abandoned: false,
    exits: false,
  };
}

/**
 * D-62's invariant, applied once to every result rather than remembered at
 * each of the fourteen places a marker is built.
 *
 * A state that waits on a gate keeps whatever identifier it was given, and
 * every other state has none: an identifier surviving a decision would point
 * resumption at an entry the tour has stopped waiting on, which is worse than
 * pointing it nowhere.
 */
function withGateRule(marker: StateMarker): StateMarker {
  const waiting = GATE_BEARING_STATES.includes(marker.state);
  if (waiting) return marker;
  return marker.gateId === null ? marker : { ...marker, gateId: null };
}

/**
 * Applies one event to a marker under the §3.2 table. Pure: no clock, no
 * disk, no git. An illegal pair throws {@link IllegalTransitionError} naming
 * the transitions the state does accept.
 */
export function transition(
  marker: StateMarker,
  event: TourEvent,
  rules: TransitionRules,
  now: Date,
): Transition {
  if (!ACCEPTS[marker.state].includes(event.type)) {
    throw new IllegalTransitionError(marker.state, event.type);
  }

  const move = (changes: Partial<StateMarker>): Transition => ({
    marker: withGateRule(stamped(marker, now, changes)),
    abandoned: false,
    exits: false,
  });

  switch (event.type) {
    case 'open':
      return { marker: withGateRule(opening(marker, now)), abandoned: false, exits: false };
    case 'plan-complete': {
      if (event.tourId.trim() === '') {
        throw new IllegalTransitionError(
          marker.state,
          'plan-complete',
          'the tour is named as its record is created, and this is where that happens (§3.3, §4.1 step 7, D-45)',
        );
      }
      return move({ state: 'EXECUTING', tourId: event.tourId, jobIndex: 0 });
    }
    case 'job-boundary': {
      if (!Number.isInteger(event.jobIndex) || event.jobIndex < 0) {
        throw new IllegalTransitionError(
          marker.state,
          'job-boundary',
          'a job boundary names the index the tour has reached, as a whole number',
        );
      }
      return move({ jobIndex: event.jobIndex });
    }
    case 'jobs-done':
      return move({ state: 'VERIFYING' });
    case 'green':
      return move({ state: 'CLOSING' });
    case 'verification-failed':
      // §4.3: capture the failure, increment attempt_count, go to FAILED.
      return move({ state: 'FAILED', attemptCount: marker.attemptCount + 1 });
    case 'retry': {
      if (marker.attemptCount >= rules.attemptBudget) {
        throw new IllegalTransitionError(
          marker.state,
          'retry',
          `the attempt budget is spent (${marker.attemptCount} of ${rules.attemptBudget}); this is where the tour-budget gate is raised instead (FR-1.3)`,
        );
      }
      return move({ state: 'EXECUTING' });
    }
    case 'raise-gate':
      return {
        marker: withGateRule(raiseGate(marker, event, rules, now)),
        abandoned: false,
        exits: false,
      };
    case 'park':
      // Expiry resolves nothing: the gate entry stays pending and is stamped,
      // not the marker's business here (D-27). interrupted_state carries.
      return move({ state: 'PARKED' });
    case 'decide': {
      const decided = decide(marker, event, now);
      return { ...decided, marker: withGateRule(decided.marker) };
    }
    case 'close':
      return { marker: withGateRule(idle(marker, now)), abandoned: false, exits: false };
  }
}

/**
 * Applies a transition and writes the marker atomically before returning
 * (§3.3, D-20), so a death after any transition lands on that transition. A
 * refused transition writes nothing.
 */
export function advance(
  root: string,
  marker: StateMarker,
  event: TourEvent,
  rules: TransitionRules,
  now: Date = new Date(),
): Transition {
  const result = transition(marker, event, rules, now);
  writeMarker(root, result.marker);
  return result;
}
