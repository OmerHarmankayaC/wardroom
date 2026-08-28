import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import { readAuditLines } from '../../src/gates/audit.js';
import {
  type EnqueueRequest,
  GateAlreadyDecidedError,
  GateNotFoundError,
  GateRefusedError,
  decide,
  enqueue,
  list,
  park,
  show,
} from '../../src/gates/queue.js';
import { readEntry } from '../../src/gates/store.js';

/**
 * The queue operations (SDD §3.1, §5.1). This is the data layer: what the
 * orchestration loop will read and write once it exists, not the loop.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-queue-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const noon = new Date('2026-08-20T13:15:00.000Z');
const later = new Date('2026-08-21T08:00:00.000Z');

const pushRequest: EnqueueRequest = {
  gateClass: 'push',
  tourId: 'tour-2',
  jobIndex: 4,
  interruptedState: 'EXECUTING',
  what: 'Push three commits to origin/main',
  why: 'TD-2 classifies git push as a critical action',
  preview: {
    kind: 'push',
    commits: [{ hash: 'c26560c', subject: 'style: remove dash separators' }],
    remote: 'origin',
    branch: 'main',
  },
};

/** Enqueues with a fixed clock and suffix so the identifier is known. */
function enqueueAt(when: Date, hex: string, overrides: Partial<EnqueueRequest> = {}) {
  return enqueue(root, { ...pushRequest, ...overrides }, { now: when, randomHex: () => hex });
}

/**
 * Runs the body with the gates directory readable but not writable, so an
 * existing entry can still be read and the log still appended to while a new
 * file cannot be created. This is how the write is failed at the moment after
 * the audit line and before the entry.
 */
function withUnwritableGatesDir(body: () => void): void {
  const { gatesDir } = wardroomPaths(root);
  chmodSync(gatesDir, 0o500);
  try {
    body();
  } finally {
    chmodSync(gatesDir, 0o700);
  }
}

function entryFiles(): string[] {
  return readdirSync(wardroomPaths(root).gatesDir).filter((name) => name.startsWith('g-'));
}

describe('enqueue', () => {
  it('writes a pending entry carrying the request', () => {
    const entry = enqueueAt(noon, 'a3f9');

    expect(entry).toEqual({
      gateId: 'g-20260820T131500Z-a3f9',
      gateClass: 'push',
      status: 'pending',
      tourId: 'tour-2',
      jobIndex: 4,
      interruptedState: 'EXECUTING',
      what: 'Push three commits to origin/main',
      why: 'TD-2 classifies git push as a critical action',
      preview: pushRequest.preview,
      recommendation: null,
      requestedAt: '2026-08-20T13:15:00.000Z',
      decidedAt: null,
      decidedBy: null,
      decisionNote: null,
      parkedAt: null,
    });
  });

  it('leaves the entry on disk for a process that has not started yet', () => {
    const entry = enqueueAt(noon, 'a3f9');

    expect(readEntry(root, entry.gateId)).toEqual(entry);
  });

  it('appends an enqueued event naming the gate', () => {
    const entry = enqueueAt(noon, 'a3f9');

    expect(readAuditLines(root)).toEqual([
      {
        ts: '2026-08-20T13:15:00.000Z',
        gateId: entry.gateId,
        event: 'enqueued',
        payload: {
          class: 'push',
          tour_id: 'tour-2',
          job_index: 4,
          what: 'Push three commits to origin/main',
        },
      },
    ]);
  });

  it('refuses a gate whose class-mandated preview is missing', () => {
    const { remote: _absent, ...withoutRemote } = pushRequest.preview as { remote: string };

    expect(() => enqueueAt(noon, 'a3f9', { preview: withoutRemote as never })).toThrow(
      GateRefusedError,
    );
  });

  it('states the field that made the preview unpresentable', () => {
    expect(() =>
      enqueueAt(noon, 'a3f9', {
        preview: { kind: 'push', commits: [], remote: 'origin', branch: 'main' },
      }),
    ).toThrow(/preview.commits/);
  });

  it('writes no file at all when the preview is refused', () => {
    try {
      enqueueAt(noon, 'a3f9', { preview: { kind: 'push', commits: [], remote: 'o', branch: 'b' } });
    } catch {
      // The refusal is the subject of the test above; what matters here is disk.
    }

    expect(entryFiles()).toEqual([]);
  });

  it('writes no audit line when the preview is refused', () => {
    try {
      enqueueAt(noon, 'a3f9', { preview: { kind: 'push', commits: [], remote: 'o', branch: 'b' } });
    } catch {
      // As above.
    }

    // A refused request is not an action, so the trail records nothing.
    expect(readAuditLines(root)).toEqual([]);
  });

  it('refuses a gate that does not say what it is asking for', () => {
    expect(() => enqueueAt(noon, 'a3f9', { what: '   ' })).toThrow(GateRefusedError);
  });

  it('refuses a gate that does not say why it is a gate', () => {
    expect(() => enqueueAt(noon, 'a3f9', { why: '' })).toThrow(GateRefusedError);
  });
});

describe('the audit line precedes the action, proven by failing the action', () => {
  it('keeps the enqueued line when the entry cannot be written', () => {
    // A directory where the entry file must go is a write the filesystem refuses.
    mkdirSync(join(wardroomPaths(root).gatesDir, 'g-20260820T131500Z-a3f9.json'));

    expect(() => enqueueAt(noon, 'a3f9')).toThrow();

    const lines = readAuditLines(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ gateId: 'g-20260820T131500Z-a3f9', event: 'enqueued' });
  });

  it('keeps the decided line when the entry cannot be rewritten', () => {
    const entry = enqueueAt(noon, 'a3f9');

    // The entry stays readable and the log stays appendable; only creating the
    // replacement file fails. That is the instant the ordering is about.
    withUnwritableGatesDir(() => {
      expect(() => decide(root, entry.gateId, 'approved', 'owner', null, { now: later })).toThrow();
    });

    expect(readAuditLines(root).map((line) => line.event)).toContain('decided');
    expect(readEntry(root, entry.gateId)?.status).toBe('pending');
  });

  it('keeps the parked line when the entry cannot be rewritten', () => {
    const entry = enqueueAt(noon, 'a3f9');

    withUnwritableGatesDir(() => {
      expect(() => park(root, entry.gateId, { now: later })).toThrow();
    });

    expect(readAuditLines(root).map((line) => line.event)).toContain('parked');
    expect(readEntry(root, entry.gateId)?.parkedAt).toBeNull();
  });
});

describe('list', () => {
  it('is empty for a repository with no gates', () => {
    expect(list(root)).toEqual([]);
  });

  it('returns pending gates oldest first', () => {
    const earlier = enqueueAt(noon, 'ffff');
    const newer = enqueueAt(new Date('2026-08-20T13:15:01.000Z'), '0000');

    expect(list(root).map((entry) => entry.gateId)).toEqual([earlier.gateId, newer.gateId]);
  });

  it('omits a gate the owner has answered', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'approved', 'owner', null, { now: later });

    expect(list(root)).toEqual([]);
  });

  it('still includes a parked gate, because parking does not answer it', () => {
    const entry = enqueueAt(noon, 'a3f9');
    park(root, entry.gateId, { now: later });

    expect(list(root).map((each) => each.gateId)).toEqual([entry.gateId]);
  });

  it('returns resolved gates when they are asked for', () => {
    const answered = enqueueAt(noon, 'a3f9');
    const waiting = enqueueAt(new Date('2026-08-20T13:15:01.000Z'), '0000');
    decide(root, answered.gateId, 'rejected', 'owner', null, { now: later });

    expect(list(root, { includeResolved: true }).map((each) => each.gateId)).toEqual([
      answered.gateId,
      waiting.gateId,
    ]);
  });
});

describe('show', () => {
  it('returns a pending gate with its full preview', () => {
    const entry = enqueueAt(noon, 'a3f9');

    expect(show(root, entry.gateId).preview).toEqual(pushRequest.preview);
  });

  it('never hides a resolved gate that is asked for by identifier', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'approved', 'owner', 'push it', { now: later });

    expect(show(root, entry.gateId).status).toBe('approved');
  });

  it('reports an identifier this repository has no gate for', () => {
    expect(() => show(root, 'g-20260820T131500Z-0000')).toThrow(GateNotFoundError);
  });
});

describe('decide', () => {
  it('records when, by whom, and with what note', () => {
    const entry = enqueueAt(noon, 'a3f9');

    const decided = decide(root, entry.gateId, 'approved', 'owner', 'green and reviewed', {
      now: later,
    });

    expect(decided).toMatchObject({
      status: 'approved',
      decidedAt: '2026-08-21T08:00:00.000Z',
      decidedBy: 'owner',
      decisionNote: 'green and reviewed',
    });
  });

  it('accepts a decision with no note', () => {
    const entry = enqueueAt(noon, 'a3f9');

    expect(
      decide(root, entry.gateId, 'rejected', 'owner', null, { now: later }).decisionNote,
    ).toBeNull();
  });

  it('leaves the decision on disk, not only in the returned value', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'rejected', 'owner', 'not yet', { now: later });

    expect(readEntry(root, entry.gateId)).toMatchObject({ status: 'rejected', decidedBy: 'owner' });
  });

  it('appends a decided event', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'approved', 'owner', 'go', { now: later });

    expect(readAuditLines(root).at(-1)).toEqual({
      ts: '2026-08-21T08:00:00.000Z',
      gateId: entry.gateId,
      event: 'decided',
      payload: { status: 'approved', decided_by: 'owner', decision_note: 'go' },
    });
  });

  it('refuses a second decision on an answered gate', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'approved', 'owner', 'go', { now: later });

    expect(() => decide(root, entry.gateId, 'rejected', 'owner', 'changed my mind')).toThrow(
      GateAlreadyDecidedError,
    );
  });

  it('leaves the first decision untouched when a second is refused', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'approved', 'owner', 'go', { now: later });

    try {
      decide(root, entry.gateId, 'rejected', 'owner', 'changed my mind');
    } catch {
      // The refusal is asserted above; this test is about what survives it.
    }

    expect(readEntry(root, entry.gateId)).toMatchObject({
      status: 'approved',
      decisionNote: 'go',
    });
    expect(readAuditLines(root).filter((line) => line.event === 'decided')).toHaveLength(1);
  });

  it('refuses a decision that records nobody as having made it', () => {
    const entry = enqueueAt(noon, 'a3f9');

    expect(() => decide(root, entry.gateId, 'approved', '  ', null, { now: later })).toThrow(
      GateRefusedError,
    );
  });

  it('answers a parked gate exactly as a fresh one', () => {
    const entry = enqueueAt(noon, 'a3f9');
    park(root, entry.gateId, { now: later });

    const decided = decide(root, entry.gateId, 'approved', 'owner', null, {
      now: new Date('2026-08-22T08:00:00.000Z'),
    });

    expect(decided.status).toBe('approved');
    expect(decided.parkedAt).toBe('2026-08-21T08:00:00.000Z');
  });
});

describe('park', () => {
  it('stamps parked_at and leaves the status pending', () => {
    const entry = enqueueAt(noon, 'a3f9');

    const parked = park(root, entry.gateId, { now: later });

    expect(parked.parkedAt).toBe('2026-08-21T08:00:00.000Z');
    expect(parked.status).toBe('pending');
  });

  it('never sets a decision field, because expiry decides nothing', () => {
    const entry = enqueueAt(noon, 'a3f9');

    const parked = park(root, entry.gateId, { now: later });

    expect(parked.decidedAt).toBeNull();
    expect(parked.decidedBy).toBeNull();
    expect(parked.decisionNote).toBeNull();
  });

  it('appends a parked event', () => {
    const entry = enqueueAt(noon, 'a3f9');
    park(root, entry.gateId, { now: later });

    expect(readAuditLines(root).at(-1)).toEqual({
      ts: '2026-08-21T08:00:00.000Z',
      gateId: entry.gateId,
      event: 'parked',
      payload: { parked_at: '2026-08-21T08:00:00.000Z' },
    });
  });

  it('refuses to park a gate the owner has already answered', () => {
    const entry = enqueueAt(noon, 'a3f9');
    decide(root, entry.gateId, 'approved', 'owner', null, { now: later });

    expect(() => park(root, entry.gateId)).toThrow(GateRefusedError);
  });

  it('refuses a second stamp, which would move the record of when the wait elapsed', () => {
    const entry = enqueueAt(noon, 'a3f9');
    park(root, entry.gateId, { now: later });

    expect(() => park(root, entry.gateId)).toThrow(/already parked|parked at/);
  });

  it('reports an identifier this repository has no gate for', () => {
    expect(() => park(root, 'g-20260820T131500Z-0000')).toThrow(GateNotFoundError);
  });
});
