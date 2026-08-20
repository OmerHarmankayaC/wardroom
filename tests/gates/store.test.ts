import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import type { GateEntry } from '../../src/gates/schema.js';
import {
  GateSchemaError,
  entryPath,
  listEntryIds,
  readEntry,
  writeEntry,
} from '../../src/gates/store.js';

/**
 * One file per gate (SDD §3.0, §3.1). The entry is the durable record of a
 * decision nobody has made yet (SRS TD-3): it outlives the process, so what it
 * owes is a full round trip and an honest refusal when a field cannot be
 * trusted.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-gates-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const entry: GateEntry = {
  gateId: 'g-20260820T131500Z-a3f9',
  gateClass: 'push',
  status: 'pending',
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
  requestedAt: '2026-08-20T13:15:00.000Z',
  decidedAt: null,
  decidedBy: null,
  decisionNote: null,
  parkedAt: null,
};

/** Rewrites the stored entry with one field replaced, bypassing the writer. */
function corrupt(patch: Record<string, unknown>): void {
  const stored = JSON.parse(readFileSync(entryPath(root, entry.gateId), 'utf8'));
  writeFileSync(entryPath(root, entry.gateId), JSON.stringify({ ...stored, ...patch }, null, 2));
}

describe('writeEntry and readEntry', () => {
  it('round-trips every SDD §3.1 field', () => {
    writeEntry(root, entry);

    expect(readEntry(root, entry.gateId)).toEqual(entry);
  });

  it('round-trips a decided, parked entry too', () => {
    const answered: GateEntry = {
      ...entry,
      status: 'rejected',
      decidedAt: '2026-08-21T08:00:00.000Z',
      decidedBy: 'owner',
      decisionNote: 'not until the branch is green',
      parkedAt: '2026-08-21T07:00:00.000Z',
    };

    writeEntry(root, answered);

    expect(readEntry(root, entry.gateId)).toEqual(answered);
  });

  it('records the fields under the on-disk names the design fixes', () => {
    writeEntry(root, entry);

    const stored = JSON.parse(readFileSync(entryPath(root, entry.gateId), 'utf8'));

    expect(Object.keys(stored).sort()).toEqual(
      [
        'class',
        'decided_at',
        'decided_by',
        'decision_note',
        'gate_id',
        'interrupted_state',
        'job_index',
        'parked_at',
        'preview',
        'requested_at',
        'status',
        'tour_id',
        'what',
        'why',
      ].sort(),
    );
  });

  it('does not store the preview discriminant a second time', () => {
    writeEntry(root, entry);

    const stored = JSON.parse(readFileSync(entryPath(root, entry.gateId), 'utf8'));

    // The preview's kind IS the gate's class. Storing both would be two homes
    // for one fact, and two homes are two answers the first time they drift.
    expect(stored.preview).not.toHaveProperty('kind');
    expect(stored.class).toBe('push');
  });

  it('is written atomically, leaving no temporary file behind', () => {
    writeEntry(root, entry);
    writeEntry(root, { ...entry, what: 'a revised request' });

    expect(readdirSync(wardroomPaths(root).gatesDir)).toEqual([`${entry.gateId}.json`]);
  });

  it('creates the gates directory on demand', () => {
    rmSync(wardroomPaths(root).gatesDir, { recursive: true, force: true });

    writeEntry(root, entry);

    expect(readEntry(root, entry.gateId)).toEqual(entry);
  });

  it('returns null for a gate that was never enqueued', () => {
    expect(readEntry(root, 'g-20260820T131500Z-0000')).toBeNull();
  });
});

describe('the three statuses', () => {
  it.each(['pending', 'approved', 'rejected'] as const)('accepts %s', (status) => {
    const decided =
      status === 'pending' ? {} : { decidedAt: '2026-08-21T08:00:00.000Z', decidedBy: 'owner' };
    writeEntry(root, { ...entry, status, ...decided });

    expect(readEntry(root, entry.gateId)?.status).toBe(status);
  });

  it('rejects `expired`, which is not a status at all', () => {
    writeEntry(root, entry);
    corrupt({ status: 'expired' });

    expect(() => readEntry(root, entry.gateId)).toThrow(GateSchemaError);
    expect(() => readEntry(root, entry.gateId)).toThrow(/pending, approved, rejected/);
  });

  it('says what expiry does instead, so the reader is not left guessing', () => {
    writeEntry(root, entry);
    corrupt({ status: 'expired' });

    expect(() => readEntry(root, entry.gateId)).toThrow(/parked_at/);
  });
});

describe('an entry that cannot be trusted', () => {
  it('refuses a malformed gate_id', () => {
    writeEntry(root, entry);
    corrupt({ gate_id: 'gate-7' });

    expect(() => readEntry(root, entry.gateId)).toThrow(/gate_id/);
  });

  it('refuses a class outside TD-2', () => {
    writeEntry(root, entry);
    corrupt({ class: 'rollback' });

    expect(() => readEntry(root, entry.gateId)).toThrow(/class/);
  });

  it('refuses an entry whose preview no longer holds', () => {
    writeEntry(root, entry);
    corrupt({ preview: { remote: 'origin', branch: 'main', commits: [] } });

    expect(() => readEntry(root, entry.gateId)).toThrow(/preview.commits/);
  });

  it('refuses a decided entry with no record of who decided', () => {
    writeEntry(root, entry);
    corrupt({ status: 'approved', decided_at: '2026-08-21T08:00:00.000Z', decided_by: null });

    expect(() => readEntry(root, entry.gateId)).toThrow(/decided_by/);
  });

  it('refuses a pending entry that carries a decision timestamp', () => {
    writeEntry(root, entry);
    corrupt({ decided_at: '2026-08-21T08:00:00.000Z' });

    expect(() => readEntry(root, entry.gateId)).toThrow(/parking is not a decision/);
  });

  it('refuses a file that is not JSON, rather than reporting it absent', () => {
    writeEntry(root, entry);
    writeFileSync(entryPath(root, entry.gateId), 'half a jso');

    expect(() => readEntry(root, entry.gateId)).toThrow(GateSchemaError);
  });

  it('reports every problem at once', () => {
    writeEntry(root, entry);
    corrupt({ what: '', why: '', tour_id: '' });

    try {
      readEntry(root, entry.gateId);
      expect.unreachable('a triply broken entry must not read clean');
    } catch (error) {
      expect((error as GateSchemaError).problems).toHaveLength(3);
    }
  });
});

describe('listEntryIds', () => {
  it('is empty for a repository with no gates directory', () => {
    rmSync(wardroomPaths(root).gatesDir, { recursive: true, force: true });

    expect(listEntryIds(root)).toEqual([]);
  });

  it('returns entries in the order the gates were raised', () => {
    const earlier = { ...entry, gateId: 'g-20260820T090000Z-ffff' };
    const later = { ...entry, gateId: 'g-20260820T090001Z-0000' };
    writeEntry(root, later);
    writeEntry(root, earlier);

    expect(listEntryIds(root)).toEqual([earlier.gateId, later.gateId]);
  });

  it('does not mistake the audit log for an entry', () => {
    writeEntry(root, entry);
    writeFileSync(wardroomPaths(root).auditLog, '{"event":"enqueued"}\n');

    expect(listEntryIds(root)).toEqual([entry.gateId]);
  });

  it('ignores a file whose name is not a gate identifier', () => {
    writeEntry(root, entry);
    writeFileSync(join(wardroomPaths(root).gatesDir, 'notes.json'), '{}');

    expect(listEntryIds(root)).toEqual([entry.gateId]);
  });

  it('keeps a resolved entry listed, because v1 does not archive', () => {
    writeEntry(root, {
      ...entry,
      status: 'approved',
      decidedAt: '2026-08-21T08:00:00.000Z',
      decidedBy: 'owner',
    });

    expect(listEntryIds(root)).toEqual([entry.gateId]);
  });
});
