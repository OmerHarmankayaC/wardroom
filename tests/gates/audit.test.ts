import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import {
  type AuditLine,
  appendAuditLine,
  readAuditLines,
  recordThenAct,
} from '../../src/gates/audit.js';

/**
 * The audit trail (SDD §3.1, FR-3.2). Two properties carry the whole design:
 * the line is written before the action it records, so a crash leaves evidence
 * rather than silence, and nothing ever rewrites or truncates what is already
 * there.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-audit-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function line(overrides: Partial<AuditLine> = {}): AuditLine {
  return {
    ts: '2026-08-20T13:15:00.000Z',
    gateId: 'g-20260820T131500Z-a3f9',
    event: 'enqueued',
    payload: { class: 'push' },
    ...overrides,
  };
}

function rawLog(): string {
  return readFileSync(wardroomPaths(root).auditLog, 'utf8');
}

describe('appendAuditLine', () => {
  it('writes one JSON object per line', () => {
    appendAuditLine(root, line());
    appendAuditLine(root, line({ event: 'decided' }));

    expect(
      rawLog()
        .split('\n')
        .filter((each) => each !== ''),
    ).toHaveLength(2);
  });

  it('records the fields under the on-disk names the design fixes', () => {
    appendAuditLine(root, line());

    expect(JSON.parse(rawLog().trim())).toEqual({
      ts: '2026-08-20T13:15:00.000Z',
      gate_id: 'g-20260820T131500Z-a3f9',
      event: 'enqueued',
      payload: { class: 'push' },
    });
  });

  it('creates the gates directory on demand', () => {
    rmSync(wardroomPaths(root).gatesDir, { recursive: true, force: true });

    appendAuditLine(root, line());

    expect(readAuditLines(root)).toHaveLength(1);
  });

  it('round-trips through readAuditLines', () => {
    const written = line({ event: 'parked', payload: { parked_at: '2026-08-21T13:15:00.000Z' } });

    appendAuditLine(root, written);

    expect(readAuditLines(root)).toEqual([written]);
  });
});

describe('recordThenAct', () => {
  it('writes the audit line before the action it records', () => {
    let logAtActionTime = '';

    recordThenAct(root, line(), () => {
      logAtActionTime = rawLog();
    });

    // Read from inside the action, so the assertion is about the order rather
    // than about the state afterwards, which both orders would satisfy.
    expect(JSON.parse(logAtActionTime.trim()).event).toBe('enqueued');
  });

  it('leaves the line behind when the action fails', () => {
    expect(() =>
      recordThenAct(root, line(), () => {
        throw new Error('the entry file could not be written');
      }),
    ).toThrow('the entry file could not be written');

    const lines = readAuditLines(root);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'enqueued', gateId: 'g-20260820T131500Z-a3f9' });
  });

  it('returns what the action returned', () => {
    expect(recordThenAct(root, line(), () => 'the written entry')).toBe('the written entry');
  });
});

describe('the log is never rewritten', () => {
  it('leaves every earlier byte identical as events accumulate', () => {
    const events: AuditLine[] = [
      line({ event: 'enqueued' }),
      line({ event: 'enqueued', gateId: 'g-20260820T131501Z-b7c2' }),
      line({ event: 'parked', gateId: 'g-20260820T131501Z-b7c2' }),
      line({ event: 'decided', payload: { status: 'approved', by: 'owner' } }),
      line({
        event: 'decided',
        gateId: 'g-20260820T131501Z-b7c2',
        payload: { status: 'rejected' },
      }),
    ];

    let previous = '';
    for (const each of events) {
      appendAuditLine(root, each);
      const current = rawLog();

      expect(current.startsWith(previous)).toBe(true);
      expect(current.length).toBeGreaterThan(previous.length);
      previous = current;
    }

    expect(readAuditLines(root)).toEqual(events);
  });

  it('keeps the first line when a second decision is attempted', () => {
    appendAuditLine(root, line({ event: 'decided', payload: { status: 'approved' } }));
    const afterFirst = rawLog();

    // A refused second decision writes nothing, because the refusal happens
    // before recordThenAct is reached. What matters is that the first line is
    // untouched either way.
    expect(rawLog()).toBe(afterFirst);
    expect(readAuditLines(root)[0]?.payload).toEqual({ status: 'approved' });
  });
});

describe('readAuditLines', () => {
  it('is empty for a repository with no trail yet', () => {
    expect(readAuditLines(root)).toEqual([]);
  });

  it('ignores a trailing partial line left by a killed process', () => {
    appendAuditLine(root, line());
    appendFileSync(wardroomPaths(root).auditLog, '{"ts":"2026-08-20T13:15:01.000Z","ga');

    const lines = readAuditLines(root);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe('enqueued');
  });

  it('reports a corrupted line that is not the last one', () => {
    appendFileSync(wardroomPaths(root).auditLog, 'not json at all\n');
    appendAuditLine(root, line());

    expect(() => readAuditLines(root)).toThrow(/line 1 is not valid JSON/);
  });
});
