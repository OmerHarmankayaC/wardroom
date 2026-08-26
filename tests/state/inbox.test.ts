import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { injectedContext, withInjectedContext } from '../../src/loop/prompts.js';
import { appendInbox, readInbox, takeUndelivered, undelivered } from '../../src/state/inbox.js';

/**
 * The owner's out-of-band context, and how delivery is recorded (SDD §3.0,
 * §5.1, FR-5.2, D-108).
 *
 * The record is written by hand wherever a reader is what is being checked,
 * and read as bytes wherever a writer is (D-55): a round trip through one
 * component's own output cannot see an assumption both halves share, and the
 * assumption here is the whole design, since delivery is derived from a mark
 * rather than stored on the line.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-inbox-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The file as bytes, one record per line. */
function lines(): Record<string, unknown>[] {
  const text = readFileSync(wardroomPaths(root).inboxFile, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** Writes records by hand, so no reader below is checked against its own writer. */
function writeRecords(records: readonly Record<string, unknown>[]): void {
  writeFileSync(
    wardroomPaths(root).inboxFile,
    records.map((record) => `${JSON.stringify(record)}\n`).join(''),
  );
}

describe('the file stays append-only, and delivery is a record of its own', () => {
  it('writes an injection with no delivery field at all', () => {
    // Stamping the line would mean rewriting the file, and a rewrite has a
    // window: an injection appended between the read and the write is silently
    // lost, which is the owner's message vanishing with nothing saying so.
    appendInbox(root, 'the pilot repository moved', '2026-08-21T10:00:00.000Z');

    expect(lines()).toEqual([
      { text: 'the pilot repository moved', written_at: '2026-08-21T10:00:00.000Z' },
    ]);
  });

  it('records a delivery by appending, leaving every injection where it was', () => {
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    appendInbox(root, 'second', '2026-08-21T11:00:00.000Z');

    takeUndelivered(root, '2026-08-21T12:00:00.000Z');

    expect(lines()).toEqual([
      { text: 'first', written_at: '2026-08-21T10:00:00.000Z' },
      { text: 'second', written_at: '2026-08-21T11:00:00.000Z' },
      { delivered_through: 2, at: '2026-08-21T12:00:00.000Z' },
    ]);
  });

  it('appends nothing where nothing was waiting', () => {
    // A mark for an empty delivery would put a record in the file for
    // something that did not happen, and `history.log` shows this file to the
    // owner.
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    takeUndelivered(root, '2026-08-21T12:00:00.000Z');

    expect(takeUndelivered(root, '2026-08-21T13:00:00.000Z')).toEqual([]);
    expect(lines()).toHaveLength(2);
  });
});

describe('delivery is derived from the mark, and the reader never wrote it', () => {
  it('reads a hand written mark as delivering the lines it reaches past', () => {
    writeRecords([
      { text: 'first', written_at: '2026-08-21T10:00:00.000Z' },
      { text: 'second', written_at: '2026-08-21T11:00:00.000Z' },
      { text: 'third', written_at: '2026-08-21T12:00:00.000Z' },
      { delivered_through: 2, at: '2026-08-21T12:30:00.000Z' },
    ]);

    expect(readInbox(root)).toEqual([
      {
        text: 'first',
        writtenAt: '2026-08-21T10:00:00.000Z',
        deliveredAt: '2026-08-21T12:30:00.000Z',
      },
      {
        text: 'second',
        writtenAt: '2026-08-21T11:00:00.000Z',
        deliveredAt: '2026-08-21T12:30:00.000Z',
      },
      { text: 'third', writtenAt: '2026-08-21T12:00:00.000Z', deliveredAt: null },
    ]);
  });

  it('gives each line the first mark that reached it, not the latest one', () => {
    writeRecords([
      { text: 'first', written_at: '2026-08-21T10:00:00.000Z' },
      { delivered_through: 1, at: '2026-08-21T10:30:00.000Z' },
      { text: 'second', written_at: '2026-08-21T11:00:00.000Z' },
      { delivered_through: 2, at: '2026-08-21T11:30:00.000Z' },
    ]);

    expect(readInbox(root).map((line) => line.deliveredAt)).toEqual([
      '2026-08-21T10:30:00.000Z',
      '2026-08-21T11:30:00.000Z',
    ]);
  });

  it('reports a mark it cannot use rather than reading past it', () => {
    writeRecords([{ delivered_through: 'two', at: '2026-08-21T10:30:00.000Z' }]);

    expect(() => readInbox(root)).toThrow(/delivered_through/);
  });
});

describe('taking is what marks, and only what was taken is marked', () => {
  it('hands back every undelivered line, stamped with the moment it was taken', () => {
    writeRecords([
      { text: 'first', written_at: '2026-08-21T10:00:00.000Z' },
      { text: 'second', written_at: '2026-08-21T11:00:00.000Z' },
      { delivered_through: 1, at: '2026-08-21T10:30:00.000Z' },
    ]);

    const taken = takeUndelivered(root, '2026-08-21T12:00:00.000Z');

    expect(taken).toEqual([
      {
        text: 'second',
        writtenAt: '2026-08-21T11:00:00.000Z',
        deliveredAt: '2026-08-21T12:00:00.000Z',
      },
    ]);
  });

  it('leaves the second reading with nothing, so a note is never delivered twice', () => {
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');

    expect(takeUndelivered(root, '2026-08-21T12:00:00.000Z')).toHaveLength(1);
    expect(takeUndelivered(root, '2026-08-21T13:00:00.000Z')).toEqual([]);
    expect(undelivered(root)).toEqual([]);
  });

  it('marks by position, so an injection arriving after the read still waits', () => {
    // The window a rewrite would have lost. The mark is a position in the file
    // rather than a claim about what is outstanding, so a line appended after
    // the read lands past it and waits for the next session.
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    takeUndelivered(root, '2026-08-21T12:00:00.000Z');
    appendInbox(root, 'arrived later', '2026-08-21T12:00:00.001Z');

    expect(undelivered(root).map((line) => line.text)).toEqual(['arrived later']);
  });
});

describe('the opening prompt carries the owner words, labelled as theirs', () => {
  it('quotes each line with the moment it was written', () => {
    const context = injectedContext([
      {
        text: 'the pilot repository moved',
        writtenAt: '2026-08-21T10:00:00.000Z',
        deliveredAt: null,
      },
    ]);

    expect(context).toMatch(/the pilot repository moved/);
    expect(context).toMatch(/2026-08-21T10:00:00\.000Z/);
  });

  it('says the context releases no gate', () => {
    // A role that could not tell a note from an instruction would read a note
    // about a push as permission to push. A gate is released by the owner
    // answering it and by nothing else (FR-3.1).
    const context = injectedContext([
      { text: 'go ahead and push', writtenAt: '2026-08-21T10:00:00.000Z', deliveredAt: null },
    ]);

    expect(context).toMatch(/releases no gate/);
  });

  it('leaves the turn alone where nothing was injected', () => {
    expect(injectedContext([])).toBe('');
    expect(withInjectedContext([], 'Job 1 of tour-4')).toBe('Job 1 of tour-4');
  });

  it('puts the context ahead of the turn it opens', () => {
    const opened = withInjectedContext(
      [{ text: 'a note', writtenAt: '2026-08-21T10:00:00.000Z', deliveredAt: null }],
      'Job 1 of tour-4',
    );

    expect(opened.indexOf('a note')).toBeLessThan(opened.indexOf('Job 1 of tour-4'));
    expect(opened.endsWith('Job 1 of tour-4')).toBe(true);
  });
});
