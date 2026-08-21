import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import {
  IllegalTransitionError,
  type TourEvent,
  advance,
  transition,
} from '../../src/state/machine.js';
import { type StateMarker, type TourState, readMarker } from '../../src/state/marker.js';

/**
 * The tour state machine (SDD §3.2) as a pure module: the transition table,
 * its guards, the attempt_count lifecycle (FR-1.3), the D-35 abandonment
 * route and the D-36 dirty-tree opening. No SDK sessions, no loop, no CLI.
 */

const RULES = { attemptBudget: 3 };
const NOW = new Date('2026-08-20T13:15:00.000Z');

function marker(overrides: Partial<StateMarker>): StateMarker {
  return {
    state: 'IDLE',
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
    headCommit: 'abc1234',
    updatedAt: '2026-08-20T12:00:00.000Z',
    ...overrides,
  };
}

function at(state: TourState, overrides: Partial<StateMarker> = {}): StateMarker {
  const open = state !== 'IDLE';
  return marker({
    state,
    tourId: open ? 'tour-3' : null,
    jobIndex: open ? 0 : null,
    interruptedState: state === 'GATED' || state === 'PARKED' ? 'EXECUTING' : null,
    ...overrides,
  });
}

function step(from: StateMarker, event: TourEvent) {
  return transition(from, event, RULES, NOW);
}

describe('the legal transitions of the SDD §3.2 table', () => {
  it('IDLE opens into PLANNING', () => {
    const result = step(at('IDLE'), { type: 'open', tourId: 'tour-3' });

    expect(result.marker.state).toBe('PLANNING');
    expect(result.marker.tourId).toBe('tour-3');
    expect(result.marker.attemptCount).toBe(0);
  });

  it('PLANNING completes into EXECUTING at job 0', () => {
    const result = step(at('PLANNING', { jobIndex: null }), { type: 'plan-complete' });

    expect(result.marker.state).toBe('EXECUTING');
    expect(result.marker.jobIndex).toBe(0);
  });

  it('EXECUTING moves to VERIFYING once the jobs are done', () => {
    expect(step(at('EXECUTING'), { type: 'jobs-done' }).marker.state).toBe('VERIFYING');
  });

  it('VERIFYING goes green into CLOSING', () => {
    expect(step(at('VERIFYING'), { type: 'green' }).marker.state).toBe('CLOSING');
  });

  it('VERIFYING fails into FAILED, incrementing attempt_count (SDD §4.3)', () => {
    const result = step(at('VERIFYING', { attemptCount: 1 }), { type: 'verification-failed' });

    expect(result.marker.state).toBe('FAILED');
    expect(result.marker.attemptCount).toBe(2);
  });

  it('CLOSING closes into IDLE, clearing the tour', () => {
    const result = step(at('CLOSING', { attemptCount: 2 }), { type: 'close' });

    expect(result.marker).toMatchObject({
      state: 'IDLE',
      tourId: null,
      jobIndex: null,
      interruptedState: null,
      attemptCount: 0,
    });
  });

  it('FAILED retries into EXECUTING while the budget holds (FR-1.3)', () => {
    const result = step(at('FAILED', { attemptCount: 2 }), { type: 'retry' });

    expect(result.marker.state).toBe('EXECUTING');
    expect(result.marker.attemptCount).toBe(2);
  });

  it('stamps updated_at with the transition clock', () => {
    const result = step(at('IDLE'), { type: 'open', tourId: 'tour-3' });

    expect(result.marker.updatedAt).toBe(NOW.toISOString());
  });
});

describe('raising a gate', () => {
  it('remembers the state it interrupted', () => {
    const result = step(at('EXECUTING', { jobIndex: 2 }), {
      type: 'raise-gate',
      gateClass: 'scope-change',
    });

    expect(result.marker.state).toBe('GATED');
    expect(result.marker.interruptedState).toBe('EXECUTING');
    expect(result.marker.jobIndex).toBe(2);
  });

  it('raises the dirty-tree gate from IDLE with the id the tour will carry (D-36)', () => {
    const result = step(at('IDLE'), {
      type: 'raise-gate',
      gateClass: 'dirty-tree',
      tourId: 'tour-3',
    });

    expect(result.marker.state).toBe('GATED');
    expect(result.marker.interruptedState).toBe('IDLE');
    expect(result.marker.tourId).toBe('tour-3');
    expect(result.marker.jobIndex).toBe(0);
  });

  it('opens the same tour either way it reaches PLANNING (D-36)', () => {
    // Two routes into PLANNING: a clean tree opens directly, a dirty one opens
    // through the gate's approval. A tour that opened under an acknowledged
    // tree is the same tour as one that opened under a clean one, so the two
    // markers must agree; letting them drift would put the pre-tour identity
    // the gate entry carries (job 0) into a state that has no job yet.
    const direct = step(at('IDLE'), { type: 'open', tourId: 'tour-3' }).marker;

    const gated = step(at('IDLE', { attemptCount: 2 }), {
      type: 'raise-gate',
      gateClass: 'dirty-tree',
      tourId: 'tour-3',
    });
    const approved = step(gated.marker, {
      type: 'decide',
      gateClass: 'dirty-tree',
      approved: true,
    }).marker;

    expect(approved).toEqual(direct);
  });

  it('refuses a dirty-tree gate without the tour id it will carry', () => {
    expect(() => step(at('IDLE'), { type: 'raise-gate', gateClass: 'dirty-tree' })).toThrow(
      /tour id/,
    );
  });

  it('refuses the dirty-tree class anywhere but IDLE', () => {
    expect(() =>
      step(at('PLANNING'), { type: 'raise-gate', gateClass: 'dirty-tree', tourId: 'tour-3' }),
    ).toThrow(IllegalTransitionError);
  });

  it('raises the tour-budget gate from FAILED once the budget is spent (FR-1.3)', () => {
    const result = step(at('FAILED', { attemptCount: 3 }), {
      type: 'raise-gate',
      gateClass: 'tour-budget',
    });

    expect(result.marker.state).toBe('GATED');
    expect(result.marker.interruptedState).toBe('FAILED');
  });

  it('refuses a tour-budget gate while the budget still holds', () => {
    expect(() =>
      step(at('FAILED', { attemptCount: 2 }), { type: 'raise-gate', gateClass: 'tour-budget' }),
    ).toThrow(/budget/);
  });

  it('refuses a retry once the budget is spent, pointing at the gate', () => {
    expect(() => step(at('FAILED', { attemptCount: 3 }), { type: 'retry' })).toThrow(/tour-budget/);
  });

  it('refuses the tour-budget class anywhere but FAILED', () => {
    expect(() => step(at('EXECUTING'), { type: 'raise-gate', gateClass: 'tour-budget' })).toThrow(
      IllegalTransitionError,
    );
  });

  it('refuses every class but tour-budget at FAILED', () => {
    // The converse guard. The table gives FAILED two exits, a retry and the
    // tour-budget gate at budget exhaustion; a scope-change gate raised from
    // FAILED would be a route the table does not carry.
    expect(() =>
      step(at('FAILED', { attemptCount: 1 }), { type: 'raise-gate', gateClass: 'scope-change' }),
    ).toThrow(/only the tour-budget gate/);
  });

  it('refuses every class but dirty-tree at IDLE', () => {
    // The converse of the dirty-tree guard. IDLE has one route into GATED and
    // it is D-36's; a push gate raised before a tour exists would carry an
    // interrupted_state the table never gives it.
    expect(() => step(at('IDLE'), { type: 'raise-gate', gateClass: 'push' })).toThrow(
      /only dirty-tree is raised at IDLE/,
    );
  });

  it('refuses a second gate while one is pending (D-14)', () => {
    // The orchestrator blocks on the gate it raised; nothing exists to raise
    // another. GATED accepts a decision or a park and nothing else.
    expect(() => step(at('GATED'), { type: 'raise-gate', gateClass: 'push' })).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('interrupted_state survives the gate round trips', () => {
  it('carries through GATED and back on approval', () => {
    const gated = step(at('EXECUTING', { jobIndex: 3 }), {
      type: 'raise-gate',
      gateClass: 'secrets',
    });
    const resumed = step(gated.marker, { type: 'decide', gateClass: 'secrets', approved: true });

    expect(resumed.marker.state).toBe('EXECUTING');
    expect(resumed.marker.interruptedState).toBeNull();
    expect(resumed.marker.jobIndex).toBe(3);
  });

  it('carries through GATED, PARKED and back, however long the park lasted', () => {
    const gated = step(at('CLOSING'), { type: 'raise-gate', gateClass: 'scope-change' });
    const parked = step(gated.marker, { type: 'park' });

    expect(parked.marker.state).toBe('PARKED');
    expect(parked.marker.interruptedState).toBe('CLOSING');

    // D-38: a decision recorded while the process was down is applied on
    // resume exactly as a live one is.
    const resumed = step(parked.marker, {
      type: 'decide',
      gateClass: 'scope-change',
      approved: true,
    });

    expect(resumed.marker.state).toBe('CLOSING');
    expect(resumed.marker.interruptedState).toBeNull();
  });

  it('returns a general rejection to interrupted_state, for the loop to record as a job', () => {
    const gated = step(at('EXECUTING'), { type: 'raise-gate', gateClass: 'scope-change' });
    const resumed = step(gated.marker, {
      type: 'decide',
      gateClass: 'scope-change',
      approved: false,
    });

    expect(resumed.marker.state).toBe('EXECUTING');
    expect(resumed.abandoned).toBe(false);
    expect(resumed.exits).toBe(false);
  });
});

describe('the tour-budget decision (FR-1.3, D-35)', () => {
  const gated = at('GATED', { interruptedState: 'FAILED', attemptCount: 3 });

  it('approval grants a fresh budget: attempt_count resets and execution resumes', () => {
    const result = step(gated, { type: 'decide', gateClass: 'tour-budget', approved: true });

    expect(result.marker.state).toBe('EXECUTING');
    expect(result.marker.attemptCount).toBe(0);
    expect(result.abandoned).toBe(false);
  });

  it('rejection abandons the tour: the closing path, never the failed state again', () => {
    // Returning to FAILED with the budget spent would re-raise the same gate
    // indefinitely; the closing path writes the log, clears the block and
    // reaches IDLE (D-35).
    const result = step(gated, { type: 'decide', gateClass: 'tour-budget', approved: false });

    expect(result.marker.state).toBe('CLOSING');
    expect(result.abandoned).toBe(true);
  });

  it('the abandoned closing closes into IDLE like any other', () => {
    const closing = step(gated, { type: 'decide', gateClass: 'tour-budget', approved: false });
    const closed = step(closing.marker, { type: 'close' });

    expect(closed.marker.state).toBe('IDLE');
    expect(closed.marker.attemptCount).toBe(0);
    expect(closed.marker.tourId).toBeNull();
  });

  it('applies the same routes from PARKED (D-38)', () => {
    const parked = at('PARKED', { interruptedState: 'FAILED', attemptCount: 3 });

    const rejected = step(parked, { type: 'decide', gateClass: 'tour-budget', approved: false });

    expect(rejected.marker.state).toBe('CLOSING');
    expect(rejected.abandoned).toBe(true);
  });
});

describe('the dirty-tree decision (FR-1.6, D-36)', () => {
  const gated = at('GATED', {
    interruptedState: 'IDLE',
    tourId: 'tour-3',
    jobIndex: 0,
  });

  it('approval completes the transition into PLANNING over the acknowledged tree', () => {
    const result = step(gated, { type: 'decide', gateClass: 'dirty-tree', approved: true });

    expect(result.marker.state).toBe('PLANNING');
    expect(result.marker.tourId).toBe('tour-3');
    expect(result.exits).toBe(false);
  });

  it('rejection leaves IDLE with the tree untouched, and the run exits', () => {
    const result = step(gated, { type: 'decide', gateClass: 'dirty-tree', approved: false });

    expect(result.marker.state).toBe('IDLE');
    expect(result.marker.tourId).toBeNull();
    expect(result.exits).toBe(true);
  });
});

describe('the attempt_count lifecycle belongs to the tour (SDD §3.2)', () => {
  it('is zero at tour open', () => {
    const opened = step(at('IDLE'), { type: 'open', tourId: 'tour-4' });

    expect(opened.marker.attemptCount).toBe(0);
  });

  it('accumulates per failed verification and is cleared at IDLE, not carried across tours', () => {
    const failed = step(at('VERIFYING', { attemptCount: 2 }), { type: 'verification-failed' });
    expect(failed.marker.attemptCount).toBe(3);

    // Without the close-time clearing, the next tour would exhaust a budget it
    // never spent.
    const gated = step(failed.marker, { type: 'raise-gate', gateClass: 'tour-budget' });
    const closing = step(gated.marker, {
      type: 'decide',
      gateClass: 'tour-budget',
      approved: false,
    });
    const closed = step(closing.marker, { type: 'close' });

    expect(closed.marker.attemptCount).toBe(0);
  });
});

describe('an illegal transition is refused naming the expected ones', () => {
  const EVENTS: Record<string, TourEvent> = {
    open: { type: 'open', tourId: 'tour-9' },
    'plan-complete': { type: 'plan-complete' },
    'jobs-done': { type: 'jobs-done' },
    green: { type: 'green' },
    'verification-failed': { type: 'verification-failed' },
    retry: { type: 'retry' },
    'raise-gate': { type: 'raise-gate', gateClass: 'scope-change' },
    park: { type: 'park' },
    decide: { type: 'decide', gateClass: 'scope-change', approved: true },
    close: { type: 'close' },
  };

  /** The whole legal (state, event-type) surface; everything else refuses. */
  const LEGAL: Record<TourState, readonly string[]> = {
    IDLE: ['open', 'raise-gate'],
    PLANNING: ['plan-complete', 'raise-gate'],
    EXECUTING: ['jobs-done', 'raise-gate'],
    VERIFYING: ['green', 'verification-failed'],
    CLOSING: ['close', 'raise-gate'],
    GATED: ['decide', 'park'],
    PARKED: ['decide'],
    FAILED: ['retry', 'raise-gate'],
  };

  for (const [state, legal] of Object.entries(LEGAL) as [TourState, readonly string[]][]) {
    for (const [name, event] of Object.entries(EVENTS)) {
      if (legal.includes(name)) continue;
      // This matrix covers the event level only: where raise-gate is legal at
      // all, which class it may carry is a separate guard, and the two
      // converse tests above are what cover those.
      it(`refuses ${name} in ${state}`, () => {
        try {
          step(at(state, state === 'FAILED' ? { attemptCount: 1 } : {}), event);
          expect.unreachable(`${state} must refuse ${name}`);
        } catch (error) {
          expect(error).toBeInstanceOf(IllegalTransitionError);
          const message = (error as Error).message;
          expect(message).toContain(state);
          for (const expected of legal) expect(message).toContain(expected);
        }
      });
    }
  }

  it('refuses to decide a GATED marker that lost its interrupted_state', () => {
    expect(() =>
      step(at('GATED', { interruptedState: null }), {
        type: 'decide',
        gateClass: 'push',
        approved: true,
      }),
    ).toThrow(/interrupted_state/);
  });
});

describe('advance writes the marker at every transition (SDD §3.3)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'wardroom-machine-'));
    ensureRunDir(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('persists each step so a death lands on the last transition, not before it', () => {
    let current = at('IDLE');
    const events: TourEvent[] = [
      { type: 'open', tourId: 'tour-3' },
      { type: 'plan-complete' },
      { type: 'jobs-done' },
      { type: 'green' },
    ];

    for (const event of events) {
      current = advance(root, current, event, RULES, NOW).marker;
      const onDisk = readMarker(root);
      expect(onDisk.kind).toBe('ok');
      if (onDisk.kind === 'ok') expect(onDisk.marker).toEqual(current);
    }

    expect(current.state).toBe('CLOSING');
  });

  it('leaves no temporary file behind, because the write is atomic (D-20)', () => {
    advance(root, at('IDLE'), { type: 'open', tourId: 'tour-3' }, RULES, NOW);

    expect(readdirSync(wardroomPaths(root).runDir)).toEqual(['state.json']);
  });

  it('writes nothing when the transition is refused', () => {
    expect(() => advance(root, at('IDLE'), { type: 'park' }, RULES, NOW)).toThrow(
      IllegalTransitionError,
    );

    expect(readMarker(root).kind).toBe('absent');
  });
});
