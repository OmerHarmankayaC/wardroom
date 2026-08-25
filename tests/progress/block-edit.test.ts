import { describe, expect, it } from 'vitest';
import { classifyBlockEdit } from '../../src/progress/block-edit.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourRead,
  parseOpenTourBlock,
} from '../../src/progress/open-tour.js';

/**
 * What the Implementer may change in the open-tour block (SDD §4.2, D-39,
 * D-95).
 *
 * The blocks below are written out as markdown and parsed, rather than built
 * as objects and handed straight to the classifier. The rule is about what an
 * edit to a file does, and a check fed only structures its own producer built
 * would never meet the shapes a session actually writes (D-55).
 */

function section(rows: readonly string[], overrides: Partial<Record<string, string>> = {}): string {
  return [
    `### Tour ${overrides.tourId ?? 'tour-9'}`,
    '',
    `- **Goal:** ${overrides.goal ?? 'Prove the guard guards.'}`,
    `- **Based on:** ${overrides.basedOn ?? 'CHARTER 1.3, SRS 1.13, SDD 1.18, BACKLOG 1.21'}`,
    `- **Opened:** ${overrides.opened ?? '2026-08-21'}`,
    '',
    '| # | Job | Acceptance criterion | Status |',
    '|---|---|---|---|',
    ...rows,
    '',
    `- **Do not touch:** ${overrides.doNotTouch ?? 'the CLI'}`,
    `- **Stop conditions:** ${overrides.stopConditions ?? 'a large deviation'}`,
  ].join('\n');
}

function read(rows: readonly string[], overrides: Partial<Record<string, string>> = {}) {
  return parseOpenTourBlock(section(rows, overrides));
}

const PLANNED = [
  '| 1 | First job | the first thing holds | done |',
  '| 2 | Second job | the second thing holds | pending |',
];

function verdict(before: OpenTourRead, after: OpenTourRead) {
  return classifyBlockEdit(before, after);
}

describe('the two changes the Implementer may make', () => {
  it('accepts a status moving on an existing row', () => {
    const result = verdict(
      read(PLANNED),
      read([PLANNED[0] as string, '| 2 | Second job | the second thing holds | in-progress |']),
    );

    expect(result).toEqual({ allowed: true, kind: 'status' });
  });

  it('accepts a row appended with its acceptance criterion (D-95)', () => {
    const result = verdict(
      read(PLANNED),
      read([...PLANNED, '| 3 | The audit finding | the pattern no longer appears | pending |']),
    );

    expect(result).toEqual({ allowed: true, kind: 'append' });
  });

  it('tells an unchanged block from a changed one, so a no-op is not read as progress', () => {
    expect(verdict(read(PLANNED), read(PLANNED))).toEqual({ allowed: true, kind: 'unchanged' });
  });
});

describe('the changes it may not make', () => {
  it('refuses an edit to an existing row text', () => {
    const result = verdict(
      read(PLANNED),
      read([PLANNED[0] as string, '| 2 | Second job | something easier | pending |']),
    );

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/row 2/);
  });

  it('refuses a reorder, and says it is a reorder rather than an edit', () => {
    const result = verdict(
      read(PLANNED),
      read([
        '| 1 | Second job | the second thing holds | pending |',
        '| 2 | First job | the first thing holds | done |',
      ]),
    );

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/different order/);
  });

  it('refuses a removal', () => {
    const result = verdict(read(PLANNED), read([PLANNED[0] as string]));

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/removes/);
  });

  it('refuses a removal dressed as an append, where the count is unchanged', () => {
    // The count check alone would pass this: one row dropped and one added
    // leaves two rows, and only comparing the rows themselves catches it.
    const result = verdict(
      read(PLANNED),
      read([PLANNED[0] as string, '| 2 | A different job | some other thing | pending |']),
    );

    expect(result.allowed).toBe(false);
  });

  for (const [field, override] of [
    ['the tour identifier', { tourId: 'tour-10' }],
    ['the goal', { goal: 'Something else entirely.' }],
    ['the document versions', { basedOn: 'CHARTER 9.9' }],
    ['the opening date', { opened: '2026-01-01' }],
    ['the do-not-touch list', { doNotTouch: 'nothing at all' }],
    ['the stop conditions', { stopConditions: 'none' }],
  ] as const) {
    it(`refuses a change to ${field}, which is the plan`, () => {
      const result = verdict(read(PLANNED), read(PLANNED, override));

      expect(result.allowed).toBe(false);
    });
  }

  it('refuses an edit that clears the block, which is closure step 6', () => {
    const result = verdict(read(PLANNED), parseOpenTourBlock(NO_OPEN_TOUR_STATEMENT));

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/closure/);
  });

  it('refuses an edit that leaves a block nothing can parse', () => {
    const result = verdict(read(PLANNED), parseOpenTourBlock('### Tour tour-9\n\nhalf a block'));

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/does not parse/);
  });

  it('refuses an edit over a block that does not currently parse', () => {
    const result = verdict(parseOpenTourBlock('### Tour tour-9\n\nrubbish'), read(PLANNED));

    expect(result.allowed).toBe(false);
  });

  it('refuses a row added where no tour is open', () => {
    const result = verdict(parseOpenTourBlock(NO_OPEN_TOUR_STATEMENT), read(PLANNED));

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/no tour is open/i);
  });
});

describe('two jobs may share a title without confusing the reorder check', () => {
  it('still refuses when the criteria move between rows carrying one title', () => {
    const result = verdict(
      read([
        '| 1 | Audit finding | the first pattern is gone | pending |',
        '| 2 | Audit finding | the second pattern is gone | pending |',
      ]),
      read([
        '| 1 | Audit finding | the second pattern is gone | pending |',
        '| 2 | Audit finding | the first pattern is gone | pending |',
      ]),
    );

    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.reason).toMatch(/different order/);
  });
});
