import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';

/**
 * The state marker (SDD §3.3). It is a hint, not evidence, and §4.4 decides
 * how far it is trusted. But it has to be *readable* for that decision to have
 * anything to work with, which is what BACKLOG D-20 is about.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-marker-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const marker: StateMarker = {
  state: 'EXECUTING',
  tourId: 'tour-1',
  jobIndex: 2,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  disposition: null,
  headCommit: 'a'.repeat(40),
  updatedAt: '2026-08-20T09:00:00.000Z',
};

function corrupt(contents: string): void {
  writeFileSync(wardroomPaths(root).stateFile, contents);
}

describe('writeMarker', () => {
  it('round-trips through the file the design names', () => {
    writeMarker(root, marker);

    const read = readMarker(root);

    expect(read).toEqual({ kind: 'ok', marker });
  });

  it('records the SDD §3.3 fields under their on-disk names', () => {
    writeMarker(root, marker);

    const onDisk = JSON.parse(readFileSync(wardroomPaths(root).stateFile, 'utf8'));

    expect(Object.keys(onDisk).sort()).toEqual([
      'attempt_count',
      'disposition',
      'gate_id',
      'head_commit',
      'interrupted_state',
      'job_index',
      'state',
      'tour_id',
      'updated_at',
    ]);
  });

  it('leaves no temporary file behind on a completed write', () => {
    writeMarker(root, marker);

    const runDir = readdirSync(wardroomPaths(root).runDir);

    expect(runDir).toEqual(['state.json']);
  });

  it('replaces a previous marker rather than appending to it', () => {
    writeMarker(root, marker);
    writeMarker(root, { ...marker, state: 'VERIFYING', attemptCount: 1 });

    const read = readMarker(root);

    expect(read).toEqual({
      kind: 'ok',
      marker: { ...marker, state: 'VERIFYING', attemptCount: 1 },
    });
  });
});

describe('readMarker', () => {
  it('reports an absent marker as absent, not as a failure', () => {
    expect(readMarker(root)).toEqual({ kind: 'absent' });
  });

  it('reports a truncated marker as unreadable', () => {
    corrupt('{"state": "EXECUT');

    expect(readMarker(root).kind).toBe('unreadable');
  });

  it('reports an empty marker as unreadable rather than as absent', () => {
    corrupt('');

    expect(readMarker(root).kind).toBe('unreadable');
  });

  it('reports a marker naming a state that does not exist as unreadable', () => {
    corrupt(JSON.stringify({ ...marker, state: 'DEAD' }));

    expect(readMarker(root).kind).toBe('unreadable');
  });

  it('reports a gated marker without its interrupted state as unreadable', () => {
    corrupt(
      JSON.stringify({
        state: 'GATED',
        tour_id: 'tour-1',
        job_index: 1,
        interrupted_state: null,
        attempt_count: 0,
        head_commit: null,
        updated_at: '2026-08-20T09:00:00.000Z',
      }),
    );

    expect(readMarker(root).kind).toBe('unreadable');
  });

  it('states why a marker could not be read', () => {
    corrupt('{"state": "EXECUT');

    const read = readMarker(root);

    expect(read.kind === 'unreadable' && read.reason.length > 0).toBe(true);
  });
});

/**
 * The disposition's lifetime (SDD §3.3, D-92 corrected by D-101).
 *
 * The rule is a lifetime and not a state test: written at the transition that
 * decides it, carried through every state after that, cleared at `IDLE`. Only
 * two ends of it are fixed enough for a schema to check, and both were failures
 * in practice: a `CLOSING` marker with no disposition sends closure back to
 * deriving one, and a verdict surviving into `IDLE` waits for the next tour to
 * find its own question already answered.
 *
 * The markers below are hand-written on-disk shapes rather than serialized
 * through `writeMarker`, because the writer would refuse to build most of them
 * and a check fed only its own producer's output would never meet one (D-55).
 */
describe('the disposition is carried from where it is decided until IDLE', () => {
  const onDisk = (overrides: Record<string, unknown>) =>
    JSON.stringify({
      state: 'CLOSING',
      tour_id: 'tour-1',
      job_index: 3,
      interrupted_state: null,
      attempt_count: 0,
      gate_id: null,
      disposition: 'closed',
      head_commit: null,
      updated_at: '2026-08-20T09:00:00.000Z',
      ...overrides,
    });

  for (const disposition of ['closed', 'abandoned', 'carried'] as const) {
    it(`reads a CLOSING marker carrying ${disposition}`, () => {
      corrupt(onDisk({ disposition }));

      const read = readMarker(root);

      expect(read.kind === 'ok' && read.marker.disposition).toBe(disposition);
    });
  }

  it('refuses a CLOSING marker that carries none', () => {
    corrupt(onDisk({ disposition: null }));

    const read = readMarker(root);

    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toMatch(/disposition/);
  });

  it('refuses a disposition that is not one of the three', () => {
    corrupt(onDisk({ disposition: 'parked' }));

    expect(readMarker(root).kind).toBe('unreadable');
  });

  /**
   * Every state between the decision and the closure, which the rule this
   * replaces refused. A carried tour decides at an `EXECUTING` boundary and
   * passes through `VERIFYING`; an abandoned one decides at a gate rejection;
   * a `scope-change` gate raised from `CLOSING` passes through `GATED`.
   */
  for (const [state, extra] of [
    ['EXECUTING', {}],
    ['VERIFYING', {}],
    ['FAILED', { attempt_count: 1 }],
    ['GATED', { interrupted_state: 'CLOSING', gate_id: 'g-20260821T090000Z-aaaa' }],
    ['PARKED', { interrupted_state: 'CLOSING', gate_id: 'g-20260821T090000Z-aaaa' }],
  ] as const) {
    it(`reads a ${state} marker carrying a disposition already decided`, () => {
      corrupt(onDisk({ state, disposition: 'carried', ...extra }));

      const read = readMarker(root);

      expect(read.kind === 'ok' && read.marker.disposition).toBe('carried');
    });
  }

  it('refuses a disposition that survived into IDLE, where the cycle clears it', () => {
    corrupt(onDisk({ state: 'IDLE', tour_id: null, job_index: null, disposition: 'carried' }));

    const read = readMarker(root);

    expect(read.kind).toBe('unreadable');
    expect(read.kind === 'unreadable' && read.reason).toMatch(/cleared at IDLE/);
  });
});
