import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { type UsageLine, appendUsage, readUsage, usageSummary } from '../../src/usage/record.js';

/**
 * The usage record (SDD §3.0, SRS NFR-4, D-74).
 *
 * Append-only, one line per session, attributed. Two things already depend on
 * it: `usage.report` reads it, and FR-1.4's boundary decision needs the cost
 * spent so far and the largest single job's cost in the current tour, neither
 * of which is recoverable from a process that has exited.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-usage-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A metered line. `unmetered()` is the same line with no cost at all. */
function line(overrides: Partial<UsageLine> = {}): UsageLine {
  return {
    ts: '2026-08-21T09:00:00.000Z',
    role: 'implementer',
    state: 'EXECUTING',
    tourId: 'tour-9',
    jobIndex: 0,
    tokens: { input: 1_000, output: 200 },
    usd: 0.5,
    ...overrides,
  };
}

/** A line from a session no meter measured (D-46): tokens, no cost. */
function unmetered(overrides: Partial<UsageLine> = {}): UsageLine {
  const { usd: _noCost, ...rest } = line(overrides);
  return rest;
}

/** Lines this module did not write, for the reader to be judged against (D-55). */
function handWritten(...records: string[]): void {
  mkdirSync(wardroomPaths(root).runDir, { recursive: true });
  writeFileSync(wardroomPaths(root).usageLog, `${records.join('\n')}\n`);
}

describe('the record is append-only and attributed', () => {
  it('writes one line per session, under the on-disk field names', () => {
    appendUsage(root, line());

    const written = JSON.parse(readFileSync(wardroomPaths(root).usageLog, 'utf8').trim());
    expect(written).toEqual({
      ts: '2026-08-21T09:00:00.000Z',
      role: 'implementer',
      state: 'EXECUTING',
      tour_id: 'tour-9',
      job_index: 0,
      tokens: { input: 1_000, output: 200 },
      usd: 0.5,
    });
  });

  it('appends rather than replacing, so an earlier session survives a later one', () => {
    appendUsage(root, line({ jobIndex: 0 }));
    appendUsage(root, line({ jobIndex: 1, usd: 0.25 }));

    expect(readUsage(root).map((entry) => entry.jobIndex)).toEqual([0, 1]);
  });

  it('carries the axes NFR-4 names as a minimum', () => {
    appendUsage(root, line({ readCategory: 'canonical-documents' }));

    expect(readUsage(root)[0]).toMatchObject({
      role: 'implementer',
      state: 'EXECUTING',
      readCategory: 'canonical-documents',
    });
  });

  it('leaves the cost out where there is no meter, and keeps the tokens', () => {
    appendUsage(root, unmetered());

    const written = JSON.parse(readFileSync(wardroomPaths(root).usageLog, 'utf8').trim());
    expect('usd' in written).toBe(false);
    expect(written.tokens).toEqual({ input: 1_000, output: 200 });
  });

  it('ignores a trailing partial line rather than refusing the whole record', () => {
    // A process killed mid-append leaves one, and refusing to read the record
    // because of its last few bytes loses the evidence it exists to keep.
    // No trailing newline after the partial: that is what a killed append
    // actually leaves, and a helper that added one would be testing a case
    // that cannot happen.
    mkdirSync(wardroomPaths(root).runDir, { recursive: true });
    writeFileSync(
      wardroomPaths(root).usageLog,
      `${JSON.stringify({
        ts: '2026-08-21T09:00:00.000Z',
        role: 'pm',
        state: 'PLANNING',
        tour_id: null,
        job_index: null,
        tokens: { input: 1, output: 1 },
      })}\n{"ts":"2026-08-21T09:01`,
    );

    expect(readUsage(root)).toHaveLength(1);
  });

  it('answers with nothing for a repository that has never been metered', () => {
    expect(readUsage(root)).toEqual([]);
  });
});

describe('the reader answers what the ceiling check asks', () => {
  beforeEach(() => {
    handWritten(
      // A planning session, no job of its own.
      JSON.stringify({
        ts: '2026-08-21T09:00:00.000Z',
        role: 'pm',
        state: 'PLANNING',
        tour_id: 'tour-9',
        job_index: null,
        tokens: { input: 100, output: 10 },
        usd: 0.1,
      }),
      JSON.stringify({
        ts: '2026-08-21T09:10:00.000Z',
        role: 'implementer',
        state: 'EXECUTING',
        tour_id: 'tour-9',
        job_index: 0,
        tokens: { input: 200, output: 20 },
        usd: 1,
      }),
      JSON.stringify({
        ts: '2026-08-21T09:20:00.000Z',
        role: 'implementer',
        state: 'EXECUTING',
        tour_id: 'tour-9',
        job_index: 1,
        tokens: { input: 300, output: 30 },
        usd: 3,
      }),
      // A second session on the same job: one job may span more than one.
      JSON.stringify({
        ts: '2026-08-21T09:30:00.000Z',
        role: 'implementer',
        state: 'EXECUTING',
        tour_id: 'tour-9',
        job_index: 1,
        tokens: { input: 50, output: 5 },
        usd: 0.5,
      }),
      // Another tour entirely.
      JSON.stringify({
        ts: '2026-08-21T09:40:00.000Z',
        role: 'implementer',
        state: 'EXECUTING',
        tour_id: 'tour-8',
        job_index: 0,
        tokens: { input: 999, output: 99 },
        usd: 99,
      }),
    );
  });

  it('sums the cost spent so far in this tour and no other', () => {
    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'api_key' });

    expect(summary.kind).toBe('measured');
    expect(summary.kind === 'measured' && summary.spentUsd).toBeCloseTo(4.6);
  });

  it('reports the largest single job, summing the sessions that job spans', () => {
    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'api_key' });

    // Job 1 cost 3 + 0.5 across two sessions, which is more than job 0's 1.
    expect(summary.kind === 'measured' && summary.largestJobUsd).toBeCloseTo(3.5);
  });

  it('does not count a session that belongs to no job as a job', () => {
    // The planning session cost 0.1 and has no job_index. It is spent, so it
    // counts against the ceiling, but it is not a job whose size predicts the
    // next one.
    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'api_key' });

    expect(summary.kind === 'measured' && summary.jobsMeasured).toBe(2);
  });

  it('reports tokens whether or not there is a meter', () => {
    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'api_key' });

    expect(summary.tokens).toEqual({ input: 650, output: 65 });
  });

  it('answers zero for a tour that has spent nothing, which is not the same as no meter', () => {
    const summary = usageSummary(root, { tourId: 'tour-100', authMode: 'api_key' });

    expect(summary.kind).toBe('measured');
    expect(summary.kind === 'measured' && summary.spentUsd).toBe(0);
  });
});

describe('an inactive meter answers inactive, never zero', () => {
  it('says so under subscription auth', () => {
    appendUsage(root, unmetered());

    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'subscription' });

    expect(summary.kind).toBe('inactive');
    expect(summary.kind === 'inactive' && summary.reason).toMatch(/subscription/);
  });

  it('still reports the tokens, which the meter being inactive does not touch', () => {
    appendUsage(root, unmetered());

    expect(usageSummary(root, { tourId: 'tour-9', authMode: 'subscription' }).tokens).toEqual({
      input: 1_000,
      output: 200,
    });
  });

  it('carries no cost fields at all, rather than zeroes standing in for them', () => {
    // Reporting a cost of zero would tell the owner the tour was free. It was
    // not measured, which is a different fact and the one D-46 insists on.
    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'subscription' });

    expect('spentUsd' in summary).toBe(false);
    expect('largestJobUsd' in summary).toBe(false);
  });

  it('says so when the meter is on but no line carries a cost', () => {
    // A record whose lines have no usd under an active meter is not a free
    // tour: it is a meter that did not run, and answering zero would let the
    // ceiling check pass on a number nobody measured.
    appendUsage(root, unmetered());

    const summary = usageSummary(root, { tourId: 'tour-9', authMode: 'api_key' });

    expect(summary.kind).toBe('inactive');
    expect(summary.kind === 'inactive' && summary.reason).toMatch(/no line/i);
  });
});
