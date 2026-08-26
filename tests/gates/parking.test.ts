import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateList } from '../../src/api/gates.js';
import { projectStatus } from '../../src/api/status.js';
import { loadConfig } from '../../src/config/load.js';
import { wardroomPaths } from '../../src/config/paths.js';
import { hasElapsed, parkElapsedGate, parkingDeadline } from '../../src/gates/parking.js';
import { decide } from '../../src/gates/queue.js';
import { readMarker } from '../../src/state/marker.js';
import { GATE_ID, gateEntry, given, makeProject, writeGateEntry } from '../api/support.js';

/**
 * Parked is computed on reading, not stamped by a timer (SDD §3.2, FR-3.3,
 * D-107).
 *
 * The case this exists for is the one no process is present at: a gate raised
 * and left overnight with the terminal closed. `run` has exited, there is no
 * daemon, and nothing is alive at the instant the waiting period runs out. If
 * parking were a stamp a live process writes, that gate would still read as
 * merely pending the next morning, which is exactly the case the state exists
 * for.
 *
 * **Nothing here is produced by what it checks (D-55).** The entry is written
 * to disk as bytes rather than through the queue that reads it. The clock is
 * an argument, so the reader is not also the thing that decides what time it
 * is. And the answer is read back out of the files themselves, not out of the
 * value the parking function returned: a function reporting on its own return
 * value would pass with nothing written at all.
 */

let root: string;

/** The moment the fixture's gate was enqueued at, as its entry records it. */
const REQUESTED_AT = '2026-08-21T09:30:00.000Z';
/** `gate_wait` is 24h in the fixture contract, so the deadline is a day later. */
const ELAPSED = new Date('2026-08-22T09:30:00.000Z');
const STILL_WAITING = new Date('2026-08-22T09:29:59.999Z');

beforeEach(() => {
  root = makeProject();
  writeGateEntry(root, gateEntry({ requested_at: REQUESTED_AT }));
  given(root, {
    state: 'GATED',
    tourId: 'tour-4',
    jobIndex: 1,
    interruptedState: 'EXECUTING',
    gateId: GATE_ID,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The marker as the file holds it, read as JSON rather than through its reader. */
function markerOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(wardroomPaths(root).stateFile, 'utf8'));
}

/** The entry as the file holds it, for the same reason. */
function entryOnDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(wardroomPaths(root).gatesDir, `${GATE_ID}.json`), 'utf8'));
}

describe('the deadline is a fact about the entry', () => {
  it('measures from when the gate was enqueued, not from when a reader arrived', () => {
    // A run that died and came back would otherwise hand the same gate a fresh
    // waiting period every restart, and a gate that restarts often enough
    // never parks at all.
    const entry = { requestedAt: REQUESTED_AT } as never;

    expect(parkingDeadline(entry, { value: 24, unit: 'h', milliseconds: 86_400_000 })).toBe(
      ELAPSED.getTime(),
    );
  });

  it('has not elapsed one millisecond before the deadline, and has at it', () => {
    const entry = { requestedAt: REQUESTED_AT } as never;
    const day = { value: 24, unit: 'h' as const, milliseconds: 86_400_000 };

    expect(hasElapsed(entry, day, STILL_WAITING)).toBe(false);
    expect(hasElapsed(entry, day, ELAPSED)).toBe(true);
  });
});

describe('the first reader parks it, with nothing alive in between', () => {
  it('writes PARKED to the marker file', () => {
    // No process was running when the wait elapsed: the entry was written by
    // hand, the marker was left at GATED, and the only thing that has happened
    // since is the clock moving.
    parkElapsedGate(root, loadConfig(root), { now: ELAPSED });

    expect(markerOnDisk().state).toBe('PARKED');
    expect(markerOnDisk().gate_id).toBe(GATE_ID);
    expect(markerOnDisk().interrupted_state).toBe('EXECUTING');
  });

  it('stamps the entry and leaves it pending, because parking decides nothing', () => {
    parkElapsedGate(root, loadConfig(root), { now: ELAPSED });

    // D-27: a parked gate IS a pending gate with `parked_at` set, so the owner
    // answers it exactly as they would a fresh one.
    expect(entryOnDisk().status).toBe('pending');
    expect(entryOnDisk().parked_at).toBe(ELAPSED.toISOString());
  });

  it('leaves both records untouched while the gate is still inside its wait', () => {
    const before = markerOnDisk();

    const outcome = parkElapsedGate(root, loadConfig(root), { now: STILL_WAITING });

    expect(outcome.kind).toBe('none');
    expect(markerOnDisk()).toEqual(before);
    expect(entryOnDisk().parked_at).toBeNull();
  });

  it('says why it did nothing rather than answering a bare no', () => {
    const outcome = parkElapsedGate(root, loadConfig(root), { now: STILL_WAITING });

    expect(outcome.kind === 'none' && outcome.reason).toMatch(/still inside its waiting period/);
  });

  it('does not park a gate the owner has already answered', () => {
    decide(root, GATE_ID, 'approved', 'owner', null, { now: new Date(REQUESTED_AT) });

    const outcome = parkElapsedGate(root, loadConfig(root), { now: ELAPSED });

    expect(outcome.kind).toBe('none');
    expect(markerOnDisk().state).toBe('GATED');
  });

  it('does not park a tour that waits on no gate', () => {
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    const outcome = parkElapsedGate(root, loadConfig(root), { now: ELAPSED });

    expect(outcome.kind).toBe('none');
    expect(markerOnDisk().state).toBe('EXECUTING');
  });

  it('changes nothing on a second reading, and says the tour is already parked', () => {
    parkElapsedGate(root, loadConfig(root), { now: ELAPSED });
    const after = markerOnDisk();

    const second = parkElapsedGate(root, loadConfig(root), {
      now: new Date('2026-08-23T09:30:00.000Z'),
    });

    expect(second.kind).toBe('already-parked');
    expect(second.kind === 'already-parked' && second.parkedAt).toBe(ELAPSED.toISOString());
    // The stamp is the moment the wait ran out as the first reader saw it, not
    // the moment somebody looked again.
    expect(markerOnDisk()).toEqual(after);
    expect(entryOnDisk().parked_at).toBe(ELAPSED.toISOString());
  });

  it('says nothing about a marker it cannot read, rather than parking on a guess', () => {
    writeFileSync(wardroomPaths(root).stateFile, '{ truncated');

    expect(parkElapsedGate(root, loadConfig(root), { now: ELAPSED }).kind).toBe('none');
  });
});

describe('status, gates and run park it identically (D-107)', () => {
  it('parks from status', () => {
    projectStatus(root, { now: ELAPSED });

    expect(markerOnDisk().state).toBe('PARKED');
  });

  it('parks from gates', () => {
    gateList(root, { now: ELAPSED });

    expect(markerOnDisk().state).toBe('PARKED');
  });

  it('reports the parked state through status once it has parked it', () => {
    const status = projectStatus(root, { now: ELAPSED });

    // Read within the same call: the reader parks and then answers, so an
    // owner returning to the repository is told the tour is parked rather than
    // being told it is gated and having to look twice.
    expect(status.state).toBe('PARKED');
    expect(status.gates).toHaveLength(1);
    expect(status.gates[0]?.parkedAt).toBe(ELAPSED.toISOString());
  });

  it('shows the parked gate through gates, still pending and still to be answered', () => {
    const listed = gateList(root, { now: ELAPSED });

    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe('pending');
    expect(listed[0]?.parkedAt).toBe(ELAPSED.toISOString());
  });

  it('leaves the same two files whichever reader arrives first', () => {
    // The point of the criterion: three readers, one answer. Each is run
    // against its own copy of the same fixture, and the files they leave are
    // compared as bytes.
    const throughStatus = { marker: markerOnDisk(), entry: entryOnDisk() };
    projectStatus(root, { now: ELAPSED });
    const afterStatus = { marker: markerOnDisk(), entry: entryOnDisk() };

    // Reset to the fixture and let the other reader arrive first instead.
    writeGateEntry(root, gateEntry({ requested_at: REQUESTED_AT }));
    writeFileSync(wardroomPaths(root).stateFile, JSON.stringify(throughStatus.marker, null, 2));
    gateList(root, { now: ELAPSED });
    const afterGates = { marker: markerOnDisk(), entry: entryOnDisk() };

    expect(afterGates).toEqual(afterStatus);
  });
});

describe('the parking function is what moved the files, and not the test', () => {
  it('leaves GATED standing when nobody reads at all', () => {
    // The discriminating case. Without it, every assertion above would pass
    // against a fixture that had been written as PARKED to begin with.
    expect(markerOnDisk().state).toBe('GATED');
    expect(entryOnDisk().parked_at).toBeNull();
    expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { state: 'GATED' } });
  });
});
