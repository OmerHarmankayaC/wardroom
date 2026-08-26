import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { historyLog } from '../../src/api/history.js';
import { readInbox, undelivered } from '../../src/api/inbox.js';
import {
  clearStopRequest,
  configShow,
  decisionInject,
  projectDetach,
  stopRequested,
} from '../../src/api/project.js';
import { usageReport } from '../../src/api/usage.js';
import { wardroomPaths } from '../../src/config/paths.js';
import {
  DOC_ROOT,
  given,
  makeProject,
  writeConfig,
  writeFile,
  writeUsageLines,
} from './support.js';

/**
 * The project operations that answer without a session (SDD §5.1).
 *
 * `detach` and `decision.inject` both write a file that something else reads,
 * so each is tested from both ends and neither end is checked only against the
 * other (D-55): the reader runs against a file written by hand, and the writer
 * is checked by reading the bytes rather than by asking its own reader.
 */

let root: string;

beforeEach(() => {
  root = makeProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('detach asks the loop to stop (FR-1.2, D-106)', () => {
  it('writes the request where a run is inside a state a stop can be honoured from', () => {
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    const result = projectDetach(root);

    expect(result).toEqual({ kind: 'requested', state: 'EXECUTING' });
    expect(existsSync(wardroomPaths(root).stopRequestFile)).toBe(true);
  });

  it('writes a file whose presence is the whole of the request', () => {
    // No contents, so nothing can disagree with the file about what was asked
    // for, and no reader has a second field to interpret.
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    projectDetach(root);

    expect(readFileSync(wardroomPaths(root).stopRequestFile, 'utf8')).toBe('');
  });

  it('says so rather than leaving a file behind where nothing is running', () => {
    given(root, { state: 'IDLE' });

    const result = projectDetach(root);

    expect(result.kind).toBe('nothing-running');
    expect(existsSync(wardroomPaths(root).stopRequestFile)).toBe(false);
  });

  it('treats a parked tour as nothing running, because the run already exited', () => {
    given(root, {
      state: 'PARKED',
      tourId: 'tour-4',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: 'g-20260821T093000Z-a1b2',
    });

    expect(projectDetach(root).kind).toBe('nothing-running');
  });

  it('treats a gated tour as running, because the run is blocked on the gate', () => {
    given(root, {
      state: 'GATED',
      tourId: 'tour-4',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: 'g-20260821T093000Z-a1b2',
    });

    expect(projectDetach(root).kind).toBe('requested');
  });

  it('refuses to guess where the marker cannot be read', () => {
    writeFileSync(wardroomPaths(root).stateFile, '{ truncated');

    const result = projectDetach(root);

    expect(result.kind).toBe('nothing-running');
    expect(result.kind === 'nothing-running' && result.reason).toMatch(/cannot be read/);
    expect(existsSync(wardroomPaths(root).stopRequestFile)).toBe(false);
  });

  it('says a project that has never been run has nothing to stop', () => {
    rmSync(wardroomPaths(root).stateFile, { force: true });

    expect(projectDetach(root).kind).toBe('nothing-running');
  });
});

describe('the stop request is read from the file, not from the writer', () => {
  it('sees a request nothing in this process wrote', () => {
    writeFileSync(wardroomPaths(root).stopRequestFile, '');

    expect(stopRequested(root)).toBe(true);
  });

  it('sees no request where the file is not there', () => {
    expect(stopRequested(root)).toBe(false);
  });

  it('clears one, and clearing one that is not there is not an error', () => {
    writeFileSync(wardroomPaths(root).stopRequestFile, '');

    clearStopRequest(root);
    clearStopRequest(root);

    expect(stopRequested(root)).toBe(false);
  });
});

describe('an injection waits in the inbox (FR-5.2, D-108)', () => {
  it('appends a line carrying its text, its time and its delivery', () => {
    decisionInject(root, 'the pilot repository moved', {
      now: new Date('2026-08-21T10:00:00.000Z'),
    });

    // Read as bytes rather than through the reader beside it: a round trip
    // through one component's own output cannot see an assumption both halves
    // share (D-55).
    const written = readFileSync(wardroomPaths(root).inboxFile, 'utf8').trim();

    expect(JSON.parse(written)).toEqual({
      text: 'the pilot repository moved',
      written_at: '2026-08-21T10:00:00.000Z',
      delivered_at: null,
    });
  });

  it('appends rather than replacing, so nothing the owner said is lost', () => {
    decisionInject(root, 'first', { now: new Date('2026-08-21T10:00:00.000Z') });
    decisionInject(root, 'second', { now: new Date('2026-08-21T11:00:00.000Z') });

    expect(readFileSync(wardroomPaths(root).inboxFile, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('reads lines this process did not write', () => {
    writeFileSync(
      wardroomPaths(root).inboxFile,
      [
        JSON.stringify({
          text: 'delivered one',
          written_at: '2026-08-21T09:00:00.000Z',
          delivered_at: '2026-08-21T09:05:00.000Z',
        }),
        JSON.stringify({
          text: 'waiting one',
          written_at: '2026-08-21T10:00:00.000Z',
          delivered_at: null,
        }),
        '',
      ].join('\n'),
    );

    expect(readInbox(root).map((line) => line.text)).toEqual(['delivered one', 'waiting one']);
    expect(undelivered(root).map((line) => line.text)).toEqual(['waiting one']);
  });

  it('reports a line it cannot use rather than dropping it', () => {
    writeFileSync(wardroomPaths(root).inboxFile, `${JSON.stringify({ text: 5 })}\n`);

    expect(() => readInbox(root)).toThrow(/text must be a string/);
  });

  it('reads an absent inbox as an empty one', () => {
    expect(readInbox(root)).toEqual([]);
  });

  it('releases no gate, because an injection is context and not a decision', () => {
    // D-108, stated as an absence: the operation appends to the inbox and
    // touches nothing else. Where the owner means to decide something gate
    // shaped, `gate.decide` is the operation.
    mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });

    decisionInject(root, 'go ahead and push', { now: new Date('2026-08-21T10:00:00.000Z') });

    expect(historyLog(root).audit).toEqual([]);
  });
});

describe('config.show returns the contract whole (FR-1.5, D-13)', () => {
  it('carries the green definition rather than a digest of it', () => {
    writeConfig(root, { verify: ['npm run test', 'npm run lint'] });

    expect(configShow(root).verify).toEqual(['npm run test', 'npm run lint']);
  });

  it('carries the parsed waiting period rather than the text it was written as', () => {
    expect(configShow(root).gateWait).toEqual({ value: 24, unit: 'h', milliseconds: 86_400_000 });
  });
});

describe('history.log carries the two records and the inbox (FR-3.2, D-108)', () => {
  it('reads the tour logs from the document root', () => {
    writeFile(root, join(DOC_ROOT, 'tours', 'tour-3.md'), '# Tour 3\n');
    writeFile(root, join(DOC_ROOT, 'tours', 'tour-4.md'), '# Tour 4\n');

    const log = historyLog(root);

    expect(log.tours.map((tour) => tour.tourId)).toEqual(['tour-3', 'tour-4']);
    expect(log.tours[0]?.contents).toBe('# Tour 3\n');
    expect(log.tours[0]?.path).toBe(join(DOC_ROOT, 'tours', 'tour-3.md'));
  });

  it('reads no tours from a project that has closed none', () => {
    expect(historyLog(root).tours).toEqual([]);
  });

  it('reads the audit trail lines something else appended', () => {
    mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
    writeFileSync(
      wardroomPaths(root).auditLog,
      `${JSON.stringify({ ts: '2026-08-21T09:30:00.000Z', gate_id: 'g-20260821T093000Z-a1b2', event: 'enqueued', payload: {} })}\n`,
    );

    expect(historyLog(root).audit.map((line) => line.event)).toEqual(['enqueued']);
  });

  it('shows what the owner told the roles and whether it arrived', () => {
    decisionInject(root, 'the pilot repository moved', {
      now: new Date('2026-08-21T10:00:00.000Z'),
    });

    expect(historyLog(root).inbox).toEqual([
      {
        text: 'the pilot repository moved',
        writtenAt: '2026-08-21T10:00:00.000Z',
        deliveredAt: null,
      },
    ]);
  });
});

describe('usage.report attributes what was spent (NFR-4)', () => {
  function line(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'job',
      ts: '2026-08-21T09:00:00.000Z',
      role: 'implementer',
      state: 'EXECUTING',
      tour_id: 'tour-4',
      job_index: 0,
      session_id: 's-1',
      tokens: { input: 100, output: 10 },
      usd: 1,
      ...overrides,
    };
  }

  it('breaks the spending down by role, by state and by job', () => {
    writeUsageLines(root, [
      line(),
      line({ job_index: 1, usd: 3, tokens: { input: 300, output: 30 } }),
      line({ role: 'pm', state: 'PLANNING', job_index: null, usd: 2 }),
    ]);

    const report = usageReport(root, { tourId: 'tour-4' });

    expect(report.byRole.map((bucket) => bucket.key).sort()).toEqual(['implementer', 'pm']);
    expect(report.byState.map((bucket) => bucket.key).sort()).toEqual(['EXECUTING', 'PLANNING']);
    expect(report.byJob.map((bucket) => bucket.key).sort()).toEqual(['0', '1', 'none']);
    expect(report.byJob.find((bucket) => bucket.key === '1')?.usd).toBe(3);
    expect(report.byJob.find((bucket) => bucket.key === '1')?.inputTokens).toBe(300);
  });

  it('leaves session lines out of the breakdown, so no job is counted twice (D-84)', () => {
    // A session line is the same spending seen whole. Adding it to the job
    // lines it reconciles would report roughly double what the summary beside
    // it reports, from the same file, in the same answer.
    writeUsageLines(root, [line(), line({ kind: 'session', job_index: null, usd: 1 })]);

    const report = usageReport(root, { tourId: 'tour-4' });

    expect(report.byRole).toHaveLength(1);
    expect(report.byRole[0]?.usd).toBe(1);
    expect(report.summary.kind === 'measured' && report.summary.spentUsd).toBe(1);
  });

  it('keeps a bucket nothing metered apart from a bucket that cost nothing (D-80)', () => {
    // Absent rather than zero: the meter did not run for this line.
    const { usd: _dropped, ...uncosted } = line({ job_index: 1 });
    writeUsageLines(root, [line(), uncosted]);

    const report = usageReport(root, { tourId: 'tour-4' });

    expect(report.byJob.find((bucket) => bucket.key === '0')?.usd).toBe(1);
    expect(report.byJob.find((bucket) => bucket.key === '1')?.usd).toBeNull();
  });

  it('answers about the tour the record last spent on where none is named', () => {
    writeUsageLines(root, [line({ tour_id: 'tour-3' }), line()]);

    expect(usageReport(root).tourId).toBe('tour-4');
  });

  it('answers about the tour asked for, not the latest one', () => {
    writeUsageLines(root, [line({ tour_id: 'tour-3', usd: 7 }), line()]);

    const report = usageReport(root, { tourId: 'tour-3' });

    expect(report.summary.kind === 'measured' && report.summary.spentUsd).toBe(7);
  });

  it('compares against the ceiling the contract carries', () => {
    writeUsageLines(root, [line({ usd: 19 })]);

    const report = usageReport(root, { tourId: 'tour-4' });

    expect(report.budget.kind !== 'inactive' && report.budget.ceilingUsd).toBe(20);
  });
});
