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
