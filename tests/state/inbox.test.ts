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

describe('the file is never rewritten, only appended to (D-113)', () => {
  /**
   * Append-only, checked as bytes rather than as lines.
   *
   * Every earlier byte survives every later operation: that is the literal
   * definition, and it catches a rewrite that happens to produce the same
   * lines, which a line-by-line check would pass. The property is what makes
   * the window harmless, and the window is the reason the design is this shape:
   * stamping a line means rewriting the file, and an injection appended between
   * the read and the write disappears without a trace.
   */
  function bytes(): string {
    try {
      return readFileSync(wardroomPaths(root).inboxFile, 'utf8');
    } catch {
      return '';
    }
  }

  it('grows by suffix at every step of a delivery cycle', () => {
    const seen: string[] = [bytes()];
    const record = () => {
      const now = bytes();
      // Each step's content begins with the step before it. Nothing earlier
      // moved, was rewritten, or was removed.
      expect(now.startsWith(seen[seen.length - 1] as string)).toBe(true);
      seen.push(now);
    };

    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    record();
    appendInbox(root, 'second', '2026-08-21T10:30:00.000Z');
    record();
    takeUndelivered(root, '2026-08-21T11:00:00.000Z');
    record();
    appendInbox(root, 'third', '2026-08-21T11:30:00.000Z');
    record();
    takeUndelivered(root, '2026-08-21T12:00:00.000Z');
    record();

    // And the whole sequence grew, so the check above was not passing on a
    // file that never changed at all.
    expect(bytes().length).toBeGreaterThan((seen[1] as string).length);
  });

  it('leaves the delivered lines byte for byte as they were written', () => {
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    const beforeDelivery = bytes();

    takeUndelivered(root, '2026-08-21T11:00:00.000Z');

    // The injection line is untouched: delivery added a record beside it and
    // did not stamp it. A stamp would be a rewrite of this exact prefix.
    expect(bytes().startsWith(beforeDelivery)).toBe(true);
    expect(bytes().slice(beforeDelivery.length)).toBe(
      `${JSON.stringify({ delivered_through: 1, at: '2026-08-21T11:00:00.000Z' })}\n`,
    );
  });

  it('delivers an injection that arrived after the count was taken, next time', () => {
    // The window itself. The mark is a position in the file rather than a
    // claim about what was outstanding, so a line that lands behind it waits
    // for the next session instead of being skipped.
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    takeUndelivered(root, '2026-08-21T11:00:00.000Z');
    appendInbox(root, 'arrived behind the marker', '2026-08-21T11:00:00.001Z');

    const next = takeUndelivered(root, '2026-08-21T12:00:00.000Z');

    expect(next.map((line) => line.text)).toEqual(['arrived behind the marker']);
  });

  it('accounts for every line exactly once across two deliveries in a row', () => {
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    appendInbox(root, 'second', '2026-08-21T10:30:00.000Z');
    const firstRound = takeUndelivered(root, '2026-08-21T11:00:00.000Z');
    appendInbox(root, 'third', '2026-08-21T11:30:00.000Z');
    const secondRound = takeUndelivered(root, '2026-08-21T12:00:00.000Z');

    // Exactly once each, in order, with nothing delivered twice and nothing
    // left behind.
    expect([...firstRound, ...secondRound].map((line) => line.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(readInbox(root).filter((line) => line.deliveredAt === null)).toEqual([]);
    expect(readInbox(root).map((line) => line.deliveredAt)).toEqual([
      '2026-08-21T11:00:00.000Z',
      '2026-08-21T11:00:00.000Z',
      '2026-08-21T12:00:00.000Z',
    ]);
  });

  it('stores no delivered flag on any injection line, since readers derive it', () => {
    appendInbox(root, 'first', '2026-08-21T10:00:00.000Z');
    takeUndelivered(root, '2026-08-21T11:00:00.000Z');

    const injections = lines().filter((record) => !Object.hasOwn(record, 'delivered_through'));

    expect(injections).toEqual([{ text: 'first', written_at: '2026-08-21T10:00:00.000Z' }]);
    // And the reader answers with one anyway, which is the point of deriving.
    expect(readInbox(root)[0]?.deliveredAt).toBe('2026-08-21T11:00:00.000Z');
  });
});
