import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import { dirtyTreeGateRequest } from '../../src/gates/dirty-tree.js';
import { type EnqueueRequest, enqueue } from '../../src/gates/queue.js';
import { GATE_CLASSES, type GateClass } from '../../src/gates/schema.js';
import { GateSchemaError, entryPath, readEntry } from '../../src/gates/store.js';

/**
 * The pre-record gate identity (SDD §3.1, §3.2, BACKLOG D-70).
 *
 * `tour_id` is null, not an empty string, for a gate raised before any tour
 * record exists: the `dirty-tree` class, and the `tour-budget` gate a run of
 * failed planning attempts raises. The reader accepts null for exactly those
 * classes and refuses it for every other, so a missing identifier cannot pass
 * as a pre-record one.
 *
 * This is the debt the repository already carried: an entry the documents
 * describe could be written and not read back.
 */

let root: string;

/** The classes a gate can be raised for before a tour record exists. */
const PRE_RECORD: readonly GateClass[] = ['dirty-tree', 'tour-budget'];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-pre-record-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const changes = [{ path: 'src/a.ts', changeType: 'modified' as const }];

function previewFor(gateClass: GateClass): EnqueueRequest['preview'] {
  switch (gateClass) {
    case 'push':
      return {
        kind: 'push',
        commits: [{ hash: 'abc1234', subject: 'feat: one' }],
        remote: 'origin',
        branch: 'main',
      };
    case 'deployment':
      return {
        kind: 'deployment',
        environment: 'staging',
        changedServices: ['api'],
        pendingMigrations: [],
      };
    case 'scope-change':
      return {
        kind: 'scope-change',
        sections: [{ document: 'SRS.md', section: '§5.1', diff: '- a\n+ b' }],
      };
    case 'destructive':
      return { kind: 'destructive', command: 'rm -rf build', affects: ['build'] };
    case 'secrets':
      return {
        kind: 'secrets',
        secret: '.env',
        role: 'implementer',
        job: 'Assemble the loop',
        call: 'Read(.env)',
      };
    case 'tour-budget':
      // The output is empty on purpose: §3.1 permits it, and the shape this
      // preview used to carry refused exactly that case (D-81).
      return {
        kind: 'tour-budget',
        attemptCount: 3,
        failure: {
          kind: 'verification',
          attempt: 3,
          command: 'npm run test',
          exitCode: 1,
          output: '',
        },
      };
    case 'dirty-tree':
      return { kind: 'dirty-tree', changes };
  }
}

function request(gateClass: GateClass, tourId: string | null): EnqueueRequest {
  return {
    gateClass,
    tourId,
    jobIndex: 0,
    interruptedState: 'IDLE',
    what: `A ${gateClass} gate`,
    why: 'a rule classified it as one',
    preview: previewFor(gateClass),
  };
}

/**
 * Writes an entry the writer did not produce.
 *
 * D-55: this job ships the writer and the reader together, so the reader is
 * exercised against JSON assembled here by hand. A round trip through
 * `enqueue` could not see an assumption both halves share, and the assumption
 * under test is exactly what the two of them agree `tour_id` may be.
 */
function handWrittenEntry(gateId: string, fields: Record<string, unknown>): void {
  writeFileSync(
    entryPath(root, gateId),
    `${JSON.stringify(
      {
        gate_id: gateId,
        class: 'dirty-tree',
        status: 'pending',
        tour_id: null,
        job_index: 0,
        interrupted_state: 'IDLE',
        what: 'A working tree carrying 1 uncommitted change',
        why: 'FR-1.6',
        preview: { kind: 'dirty-tree', changes: [{ path: 'src/a.ts', changeType: 'modified' }] },
        requested_at: '2026-08-21T09:00:00.000Z',
        decided_at: null,
        decided_by: null,
        decision_note: null,
        parked_at: null,
        ...fields,
      },
      null,
      2,
    )}\n`,
  );
}

describe('a pre-record gate carries no tour identifier', () => {
  it.each(PRE_RECORD)('writes and reads back a %s gate with a null tour_id', (gateClass) => {
    const written = enqueue(root, request(gateClass, null));

    expect(written.tourId).toBeNull();
    expect(readEntry(root, written.gateId)?.tourId).toBeNull();
  });

  it('reads back an entry this code did not write', () => {
    // The previous reader refused this exact file. It is the whole debt.
    handWrittenEntry('g-20260821T090000Z-aaaa', {});

    expect(readEntry(root, 'g-20260821T090000Z-aaaa')?.tourId).toBeNull();
  });

  it('still carries the tour where a tour-budget gate has one', () => {
    // Verification exhaustion happens inside a tour, so that tour-budget gate
    // names it. Null is permitted for the class, not required of it.
    const written = enqueue(root, request('tour-budget', 'tour-9'));

    expect(readEntry(root, written.gateId)?.tourId).toBe('tour-9');
  });
});

describe('a null identifier is refused everywhere else', () => {
  const others = GATE_CLASSES.filter((gateClass) => !PRE_RECORD.includes(gateClass));

  it.each(others)('refuses a null tour_id on a %s gate', (gateClass) => {
    handWrittenEntry('g-20260821T090000Z-bbbb', {
      class: gateClass,
      preview: previewFor(gateClass),
      tour_id: null,
    });

    expect(() => readEntry(root, 'g-20260821T090000Z-bbbb')).toThrowError(GateSchemaError);
  });

  it('names the classes that may carry null, so the refusal can be acted on', () => {
    handWrittenEntry('g-20260821T090000Z-cccc', {
      class: 'push',
      preview: previewFor('push'),
      tour_id: null,
    });

    expect(() => readEntry(root, 'g-20260821T090000Z-cccc')).toThrowError(/dirty-tree/);
    expect(() => readEntry(root, 'g-20260821T090000Z-cccc')).toThrowError(/tour-budget/);
  });

  it('does not let a missing identifier pass as a pre-record one', () => {
    // The mutation this exists for: accepting null for every class turns a
    // forgotten tour_id into a valid entry, and the gate then reads as though
    // it was raised before any tour existed.
    handWrittenEntry('g-20260821T090000Z-dddd', {
      class: 'destructive',
      preview: previewFor('destructive'),
      tour_id: null,
    });

    expect(() => readEntry(root, 'g-20260821T090000Z-dddd')).toThrowError(GateSchemaError);
  });
});

describe('an empty string is refused everywhere', () => {
  it.each(GATE_CLASSES)('refuses an empty tour_id on a %s gate', (gateClass) => {
    handWrittenEntry('g-20260821T090000Z-eeee', {
      class: gateClass,
      preview: previewFor(gateClass),
      tour_id: '',
    });

    expect(() => readEntry(root, 'g-20260821T090000Z-eeee')).toThrowError(GateSchemaError);
  });

  it('distinguishes absent from empty, because they say different things', () => {
    // Null is a determinate fact: no tour record exists. An empty string is a
    // field somebody failed to fill, and collapsing the two would report the
    // second as the first (D-32).
    handWrittenEntry('g-20260821T090000Z-ffff', { tour_id: '' });

    expect(() => readEntry(root, 'g-20260821T090000Z-ffff')).toThrowError(/empty/i);
  });
});

describe('the dirty-tree request takes no identifier', () => {
  it('carries a null tour_id', () => {
    expect(dirtyTreeGateRequest(changes).tourId).toBeNull();
  });

  it('names the tree it is about, never the tour it precedes', () => {
    // Nothing mints an identifier at that approval: the gate is a decision
    // about the working tree, and the identifier is minted when the tour
    // record is created (§3.2, §3.3, D-45, D-70).
    const what = dirtyTreeGateRequest(changes).what;

    expect(what).not.toMatch(/tour-\d/);
    expect(what).toMatch(/working tree/i);
    expect(what).toMatch(/1 uncommitted change\b/);
  });

  it('counts the changes it was given', () => {
    expect(dirtyTreeGateRequest([...changes, { path: 'b.ts', changeType: 'added' }]).what).toMatch(
      /2 uncommitted changes/,
    );
  });

  it('keeps IDLE as the state it interrupted and job 0 as its position', () => {
    expect(dirtyTreeGateRequest(changes)).toMatchObject({
      gateClass: 'dirty-tree',
      jobIndex: 0,
      interruptedState: 'IDLE',
    });
  });
});
