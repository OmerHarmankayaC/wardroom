import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { IllegalTransitionError, type TourEvent, advance } from '../../src/state/machine.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';

/**
 * Counts real write traffic through Wardroom's one write primitive, calling
 * through to it rather than replacing it.
 *
 * Comparing the file before and after a transition cannot see a second write
 * of the same contents, and a transition that writes an intermediate state the
 * machine never claims to be in is exactly the defect worth catching: a death
 * inside it would land resumption on a state no rule produced.
 */
const writes: string[] = [];
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/fs/atomic.js')>();
  return {
    ...real,
    atomicWriteFile: (target: string, contents: string) => {
      writes.push(target);
      real.atomicWriteFile(target, contents);
    },
  };
});

/**
 * The marker's gate identity (SDD §3.3, D-62) and the writer that keeps it
 * true at every transition (§3.2, D-47).
 *
 * The sequence below is read from a JSON script written by hand off the §3.2
 * table. `advance` did not produce it and could not have: that is the point.
 * D-55 forbids a criterion that rests only on its own producer's output, and
 * this job ships the writer and the check on the writer together, which is
 * exactly the shape the rule names.
 */

interface Step {
  readonly event: TourEvent;
  readonly expect: Partial<StateMarker>;
}

const script = JSON.parse(
  readFileSync(join(import.meta.dirname, 'transitions.fixture.json'), 'utf8'),
) as { attemptBudget: number; steps: readonly Step[] };

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-transitions-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const START: StateMarker = {
  state: 'IDLE',
  tourId: null,
  jobIndex: null,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  disposition: null,
  headCommit: null,
  updatedAt: '2026-08-21T08:00:00.000Z',
};

/** Marker writes seen so far, from the counter above. */
function markerWrites(): number {
  return writes.filter((target) => target === wardroomPaths(root).stateFile).length;
}

describe('the writer walks a script it did not produce', () => {
  it('reaches every state the script names, in order', () => {
    let marker = START;
    const reached: string[] = [];

    for (const step of script.steps) {
      marker = advance(root, marker, step.event, { attemptBudget: script.attemptBudget }).marker;
      reached.push(marker.state);

      for (const [field, value] of Object.entries(step.expect)) {
        expect({
          event: step.event.type,
          field,
          value: marker[field as keyof StateMarker],
        }).toEqual({ event: step.event.type, field, value });
      }
    }

    expect(reached).toEqual(script.steps.map((step) => step.expect.state));
  });

  it('leaves the marker on disk equal to the marker it returned, at every step', () => {
    let marker = START;

    for (const step of script.steps) {
      marker = advance(root, marker, step.event, { attemptBudget: script.attemptBudget }).marker;
      const read = readMarker(root);

      expect(read.kind).toBe('ok');
      if (read.kind !== 'ok') return;
      expect(read.marker).toEqual(marker);
    }
  });

  it('writes exactly one marker per transition, no more and no fewer', () => {
    let marker = START;
    const before = markerWrites();

    for (const step of script.steps) {
      marker = advance(root, marker, step.event, { attemptBudget: script.attemptBudget }).marker;
    }

    expect(markerWrites() - before).toBe(script.steps.length);
  });

  it('writes nothing when the transition is refused', () => {
    writeMarker(root, START);
    const before = readMarker(root);
    const count = markerWrites();

    expect(() =>
      advance(
        root,
        START,
        { type: 'green', disposition: 'closed' },
        { attemptBudget: script.attemptBudget },
      ),
    ).toThrowError(IllegalTransitionError);
    expect(readMarker(root)).toEqual(before);
    expect(markerWrites()).toBe(count);
  });
});

describe('gate_id is mandatory in GATED and PARKED and null everywhere else', () => {
  const gated: StateMarker = {
    ...START,
    state: 'GATED',
    tourId: 'tour-9',
    interruptedState: 'EXECUTING',
    gateId: 'g-20260821T090000Z-aaaa',
  };

  it('refuses a GATED marker on disk that names no gate', () => {
    mkdirSync(wardroomPaths(root).runDir, { recursive: true });
    writeMarker(root, { ...gated, gateId: null });

    const read = readMarker(root);
    expect(read.kind).toBe('unreadable');
    if (read.kind !== 'unreadable') return;
    expect(read.reason).toMatch(/gate_id/);
  });

  it('refuses a PARKED marker that names no gate', () => {
    writeMarker(root, { ...gated, state: 'PARKED', gateId: null });

    expect(readMarker(root).kind).toBe('unreadable');
  });

  it('refuses a gate id on a state that waits on no gate', () => {
    // A stale identifier on EXECUTING would send resumption to an entry the
    // tour is not waiting on, which is worse than none at all.
    writeMarker(root, { ...START, state: 'EXECUTING', gateId: 'g-20260821T090000Z-aaaa' });

    const read = readMarker(root);
    expect(read.kind).toBe('unreadable');
    if (read.kind !== 'unreadable') return;
    expect(read.reason).toMatch(/gate_id/);
  });

  it('accepts a GATED marker that names its gate', () => {
    writeMarker(root, gated);

    expect(readMarker(root).kind).toBe('ok');
  });

  it('refuses to raise a gate without the identifier it will wait on', () => {
    // The mutation this exists for: dropping gate_id from a GATED write makes
    // the marker name no entry, and resumption cannot find what it waits on.
    expect(() =>
      advance(
        root,
        { ...START, state: 'EXECUTING', tourId: 'tour-9' },
        { type: 'raise-gate', gateClass: 'push', gateId: '' },
        { attemptBudget: 2 },
      ),
    ).toThrowError(/gate_id|gate id/i);
  });

  it('clears the identifier when the gate is decided', () => {
    const decided = advance(
      root,
      gated,
      { type: 'decide', gateClass: 'push', approved: true },
      { attemptBudget: 2 },
    );

    expect(decided.marker.gateId).toBeNull();
    expect(decided.marker.state).toBe('EXECUTING');
  });

  it('carries the identifier through parking, which decides nothing', () => {
    const parked = advance(root, gated, { type: 'park' }, { attemptBudget: 2 });

    expect(parked.marker.gateId).toBe('g-20260821T090000Z-aaaa');
  });
});
