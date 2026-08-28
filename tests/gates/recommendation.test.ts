import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderGate } from '../../src/cli/render.js';
import { wardroomPaths } from '../../src/config/paths.js';
import { GateRefusedError, enqueue } from '../../src/gates/queue.js';
import { GateSchemaError, entryPath, readEntry } from '../../src/gates/store.js';

/**
 * The recommendation, and the emptiness list it belongs on (SDD §3.1, FR-3.4,
 * D-114, D-116).
 *
 * FR-3.4 asks a gate to state what the PM recommends and no field carried one,
 * so a surface could only invent advice from the gate's own class, which
 * advises nothing and reads as advice. D-114 made the field optional and D-116
 * counted it as the fourth determinate emptiness, without which the reader
 * D-70 tightened would have refused nearly every entry there is.
 *
 * The entries below are written to disk by hand wherever a reader is what is
 * under test (D-55). An entry the writer produced can only ever be in a shape
 * the writer thought of, and the case that matters most here is the one the
 * writer never produces: an entry from before this field existed.
 */

let root: string;

const GATE_ID = 'g-20260821T093000Z-a1b2';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-recommend-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** An entry as bytes, with whatever the caller wants to vary or leave out. */
function writeRaw(overrides: Record<string, unknown> = {}): void {
  const record: Record<string, unknown> = {
    gate_id: GATE_ID,
    class: 'push',
    status: 'pending',
    tour_id: 'tour-5',
    job_index: 1,
    interrupted_state: 'EXECUTING',
    what: 'Push 3 commits to origin/main',
    why: 'a push leaves the machine (TD-2)',
    preview: {
      commits: [{ hash: 'abc1234', subject: 'feat: one' }],
      remote: 'origin',
      branch: 'main',
    },
    requested_at: '2026-08-21T09:30:00.000Z',
    decided_at: null,
    decided_by: null,
    decision_note: null,
    parked_at: null,
    ...overrides,
  };
  writeFileSync(join(wardroomPaths(root).gatesDir, `${GATE_ID}.json`), JSON.stringify(record));
}

describe('an entry with no recommendation reads back (D-116)', () => {
  it('reads an entry that does not carry the field at all', () => {
    // The case the reader refused before it was counted, and the shape of
    // every entry this project has ever written.
    writeRaw();

    expect(readEntry(root, GATE_ID)?.recommendation).toBeNull();
  });

  it('reads an explicit null the same way', () => {
    writeRaw({ recommendation: null });

    expect(readEntry(root, GATE_ID)?.recommendation).toBeNull();
  });

  it('reads a recommendation somebody wrote', () => {
    writeRaw({
      recommendation: 'Approve: the three commits are the tour, and the remote is yours.',
    });

    expect(readEntry(root, GATE_ID)?.recommendation).toBe(
      'Approve: the three commits are the tour, and the remote is yours.',
    );
  });
});

describe('the reader still refuses what it refused before', () => {
  it('refuses a blank recommendation, as it refuses a blank tour_id', () => {
    // Null says nobody advised; a blank string says somebody meant to and did
    // not. An owner shown the first when the truth is the second is being told
    // there was no view to have.
    writeRaw({ recommendation: '   ' });

    expect(() => readEntry(root, GATE_ID)).toThrow(GateSchemaError);
    expect(() => readEntry(root, GATE_ID)).toThrow(/recommendation: is empty/);
  });

  it('refuses a recommendation that is not text', () => {
    writeRaw({ recommendation: 7 });

    expect(() => readEntry(root, GATE_ID)).toThrow(/recommendation: must be a string or null/);
  });

  it('still refuses an absent mandatory field, so the exception did not widen', () => {
    // The check the emptiness list exists alongside. Counting one more field
    // as optional must not turn every field optional, and `what` is the one
    // that would be missed first.
    writeRaw({ what: undefined });

    expect(() => readEntry(root, GATE_ID)).toThrow(/what: must state the action/);
  });

  it('still refuses a blank tour_id, which is the same rule one field over', () => {
    writeRaw({ tour_id: '' });

    expect(() => readEntry(root, GATE_ID)).toThrow(/tour_id: is empty/);
  });
});

describe("§3.1's four determinate emptinesses, checked against the reader", () => {
  // Checked against the reader rather than against the prose: the four live in
  // four different places in the code, and a field added to the document's
  // list without being added here is exactly how this one was missed.
  it('accepts an empty pending_migrations list, which says there are none', () => {
    writeRaw({
      class: 'deployment',
      preview: { environment: 'production', changedServices: ['api'], pendingMigrations: [] },
    });

    expect(readEntry(root, GATE_ID)?.gateClass).toBe('deployment');
  });

  it('accepts an empty last-failure output, since a command can fail silently', () => {
    writeRaw({
      class: 'tour-budget',
      preview: {
        attemptCount: 3,
        failure: { kind: 'verification', attempt: 3, command: 'npm test', exitCode: 1, output: '' },
      },
    });

    expect(readEntry(root, GATE_ID)?.gateClass).toBe('tour-budget');
  });

  it('accepts a null tour_id on a gate raised before any tour record', () => {
    writeRaw({
      class: 'dirty-tree',
      tour_id: null,
      job_index: 0,
      interrupted_state: 'IDLE',
      preview: { changes: [{ path: 'src/thing.ts', changeType: 'modified' }] },
    });

    expect(readEntry(root, GATE_ID)?.tourId).toBeNull();
  });

  it('accepts an absent recommendation, which is the fourth', () => {
    writeRaw();

    expect(readEntry(root, GATE_ID)?.recommendation).toBeNull();
  });
});

describe('the writer carries one where a role formed a view', () => {
  it('records what the caller advised', () => {
    const entry = enqueue(root, {
      gateClass: 'push',
      tourId: 'tour-5',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'Push 3 commits to origin/main',
      why: 'a push leaves the machine (TD-2)',
      preview: {
        kind: 'push',
        commits: [{ hash: 'abc1234', subject: 'feat: one' }],
        remote: 'origin',
        branch: 'main',
      },
      recommendation: 'Approve: these are the tour, and the remote is yours.',
    });

    // Read from disk rather than from the return value: the writer is what is
    // under test and cannot be its own evidence (D-55).
    const stored = JSON.parse(readFileSync(entryPath(root, entry.gateId), 'utf8'));
    expect(stored.recommendation).toBe('Approve: these are the tour, and the remote is yours.');
  });

  it('records null where the caller offered none, which is the hook', () => {
    const entry = enqueue(root, {
      gateClass: 'push',
      tourId: 'tour-5',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'Push 3 commits to origin/main',
      why: 'a push leaves the machine (TD-2)',
      preview: {
        kind: 'push',
        commits: [{ hash: 'abc1234', subject: 'feat: one' }],
        remote: 'origin',
        branch: 'main',
      },
    });

    expect(
      JSON.parse(readFileSync(entryPath(root, entry.gateId), 'utf8')).recommendation,
    ).toBeNull();
  });

  it('refuses a blank one rather than storing it', () => {
    expect(() =>
      enqueue(root, {
        gateClass: 'push',
        tourId: 'tour-5',
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        what: 'Push 3 commits to origin/main',
        why: 'a push leaves the machine (TD-2)',
        preview: {
          kind: 'push',
          commits: [{ hash: 'abc1234', subject: 'feat: one' }],
          remote: 'origin',
          branch: 'main',
        },
        recommendation: '  ',
      }),
    ).toThrow(GateRefusedError);
  });
});

describe('the owner reads it, and reads its absence as absence (FR-3.4, D-51)', () => {
  it('shows what the PM advised', () => {
    writeRaw({ recommendation: 'Reject: origin is the public repository.' });
    const entry = readEntry(root, GATE_ID);
    if (entry === null) throw new Error('the fixture entry should read back');

    expect(renderGate(entry).join('\n')).toContain(
      'What the PM recommends: Reject: origin is the public repository.',
    );
  });

  it('says nothing is recorded rather than deriving one from the class', () => {
    writeRaw();
    const entry = readEntry(root, GATE_ID);
    if (entry === null) throw new Error('the fixture entry should read back');

    const shown = renderGate(entry).join('\n');
    expect(shown).toContain('nothing is recorded');
    // Not a sentence about pushes reworded as advice: the gate's own rule is
    // already on the line above, under why you are being asked.
    expect(shown).not.toMatch(/What the PM recommends:.*push/i);
  });
});
