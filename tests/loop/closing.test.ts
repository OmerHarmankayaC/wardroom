import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { readDocBaseline } from '../../src/documents/baseline.js';
import { list } from '../../src/gates/queue.js';
import { driveClosing } from '../../src/loop/closing.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  readOpenTour,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import type { OpenTourBlock } from '../../src/progress/open-tour.js';
import { readLastFailure, writeLastFailure } from '../../src/state/last-failure.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';
import { type ClosingReport, writeReport } from '../../src/state/report.js';

/**
 * Tour closure (SDD §4.6, §3.2, D-72, D-73, D-75, D-76).
 *
 * The procedure the document never had until this tour's doc-first pass: every
 * other state in §3.2 had a section and this one had a table cell, which is how
 * the artifacts §4.4 and §4.5 require came to be produced by nothing.
 *
 * The load-bearing property is step 2. The report is a record, not evidence: a
 * report that is wrong about what it did is the ordinary case, not the
 * exceptional one, and closure is the last moment anything checks.
 */

let root: string;

const DOC_ROOT = 'internal/docs';

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: DOC_ROOT,
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['true'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 2,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

const block: OpenTourBlock = {
  tourId: 'tour-9',
  goal: 'Prove closure closes.',
  basedOn: 'CHARTER 1.3, SRS 1.12, SDD 1.13, BACKLOG 1.15',
  opened: '2026-08-21',
  jobs: [{ title: 'First job', criterion: 'the first thing holds', status: 'done' }],
  doNotTouch: 'anything else',
  stopConditions: 'a large deviation',
};

const CLOSING_MARKER: StateMarker = {
  state: 'CLOSING',
  tourId: 'tour-9',
  jobIndex: 1,
  interruptedState: null,
  attemptCount: 1,
  gateId: null,
  headCommit: null,
  updatedAt: '2026-08-21T09:00:00.000Z',
};

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function writeProgress(body: string): void {
  write(
    join(DOC_ROOT, 'PROGRESS.md'),
    ['# PROGRESS', '', '## Open tour', '', body, '', '## Pending', '', 'nothing', ''].join('\n'),
  );
}

function srs(version: string, body = '## 1. Overview'): string {
  return [
    '# Software Requirements Specification',
    '',
    `Version ${version} · 2026-08-21`,
    '',
    '| Version | Date | Change |',
    '|---|---|---|',
    `| ${version} | 2026-08-21 | a row |`,
    '',
    body,
    '',
  ].join('\n');
}

const report: ClosingReport = {
  tourId: 'tour-9',
  commits: [],
  pushed: false,
  jobs: [{ title: 'First job', verdict: 'done' }],
  debts: [],
  notes: 'nothing else',
};

/** A PM that settles whatever it is handed by bumping the document. */
function pm() {
  const settled: string[] = [];
  return {
    settled,
    session: {
      settleDebt: async (debt: { document: string }) => {
        settled.push(debt.document);
        write(join(DOC_ROOT, debt.document), srs('1.4', '## 1. Overview, settled'));
      },
      writeTourLog: async (log: { tourId: string; body: string }) => {
        write(join(DOC_ROOT, 'tours', `${log.tourId}.md`), log.body);
      },
    },
  };
}

let headCommit = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-closing-'));
  ensureRunDir(root);
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'f@example.invalid');
  git('config', 'user.name', 'Fixture');
  write('.gitignore', '/internal/\n');
  write(join(DOC_ROOT, 'SRS.md'), srs('1.3'));
  write('README.md', '# fixture\n');
  writeProgress(renderOpenTourBlock(block));
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  headCommit = git('rev-parse', 'HEAD').trim();
  writeMarker(root, CLOSING_MARKER);
  writeReport(root, report);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function close(overrides: Partial<Parameters<typeof driveClosing>[0]> = {}) {
  return driveClosing({
    root,
    config,
    marker: CLOSING_MARKER,
    session: pm().session,
    disposition: 'closed',
    now: NOW,
    ...overrides,
  });
}

describe('closure reads the report from disk, not from a session', () => {
  it('refuses to close a tour that left no report', async () => {
    rmSync(join(wardroomPaths(root).reportsDir, 'tour-9.md'));

    await expect(close()).rejects.toThrowError(/report/i);
  });

  it('refuses to drive from a state that is not CLOSING', async () => {
    await expect(close({ marker: { ...CLOSING_MARKER, state: 'VERIFYING' } })).rejects.toThrowError(
      /CLOSING/,
    );
  });
});

describe('the report claims are checked against .git, never adopted (§4.6 step 2)', () => {
  it('accepts a report whose commit claim the repository confirms', async () => {
    writeReport(root, { ...report, commits: [headCommit.slice(0, 7)] });

    const result = await close();

    expect(result.claimCheck.commits).toEqual([]);
  });

  it('disagrees with a report claiming a commit that does not exist', async () => {
    // The test that matters: a report that is WRONG about what it did, and
    // closure disagreeing with it from .git rather than believing it.
    writeReport(root, { ...report, commits: ['0000000deadbeef'] });

    const result = await close();

    expect(result.claimCheck.commits).toHaveLength(1);
    expect(result.claimCheck.commits[0]).toMatch(/0000000deadbeef/);
  });

  it('disagrees with a report claiming a commit that is not on this branch', async () => {
    const orphan = git('commit-tree', '-m', 'orphan', `${headCommit}^{tree}`).trim();
    writeReport(root, { ...report, commits: [orphan] });

    const result = await close();

    expect(result.claimCheck.commits).toHaveLength(1);
  });

  it('disagrees with a report claiming a push that never happened', async () => {
    writeReport(root, { ...report, pushed: true });

    const result = await close();

    expect(result.claimCheck.push).toMatch(/no remote|not/i);
  });

  it('accepts a report claiming no push, which is the ordinary case', async () => {
    const result = await close();

    expect(result.claimCheck.push).toBeNull();
  });

  it('records the disagreement rather than refusing to close', async () => {
    // Closure is the last moment anything checks, and a tour whose report was
    // wrong still has to close: the tour log is where the disagreement is kept.
    writeReport(root, { ...report, commits: ['0000000deadbeef'], pushed: true });

    const result = await close();

    expect(result.kind).toBe('closed');
    expect(result.tourLog).toMatch(/0000000deadbeef/);
  });
});

describe('document debts are settled, or they raise a gate (§4.6 step 3, D-75)', () => {
  it('hands each settleable debt to the PM', async () => {
    writeReport(root, {
      ...report,
      debts: [{ document: 'SRS.md', section: '1.1', problem: 'a problem', settleable: true }],
    });
    const role = pm();

    await close({ session: role.session });

    expect(role.settled).toEqual(['SRS.md']);
  });

  it('raises a scope-change gate for one the PM cannot settle', async () => {
    writeReport(root, {
      ...report,
      debts: [
        { document: 'SDD.md', section: '4.6', problem: 'the order is wrong', settleable: false },
      ],
    });

    const result = await close();

    expect(result.kind).toBe('gated');
    const entry = list(root)[0];
    expect(entry?.gateClass).toBe('scope-change');
    expect(entry?.interruptedState).toBe('CLOSING');
    expect(entry?.preview.kind === 'scope-change' && entry.preview.sections[0]?.document).toBe(
      'SDD.md',
    );
  });

  it('does not clear the block when a debt sent it to a gate', async () => {
    // §3.2: CLOSING cannot reach IDLE with an open document debt. Clearing the
    // block first would lose the tour the gate is about.
    writeReport(root, {
      ...report,
      debts: [{ document: 'SDD.md', section: '4.6', problem: 'unsettleable', settleable: false }],
    });

    await close();

    expect(readOpenTour(root, DOC_ROOT).kind).toBe('open');
  });

  it('leaves the marker GATED naming the gate it waits on', async () => {
    writeReport(root, {
      ...report,
      debts: [{ document: 'SDD.md', section: '4.6', problem: 'unsettleable', settleable: false }],
    });

    const result = await close();

    expect(result.marker.state).toBe('GATED');
    expect(result.marker.gateId).toBe(list(root)[0]?.gateId);
  });
});

describe('the closure writes what a later reader needs (§4.6 steps 4 to 7)', () => {
  it('writes the tour log under the tour-log directory', async () => {
    const result = await close();

    expect(existsSync(join(root, DOC_ROOT, 'tours', 'tour-9.md'))).toBe(true);
    expect(readFileSync(join(root, DOC_ROOT, 'tours', 'tour-9.md'), 'utf8')).toBe(result.tourLog);
  });

  it('records the disposition in the log', async () => {
    const result = await close({ disposition: 'carried' });

    expect(result.kind).toBe('closed');
    expect(result.kind === 'closed' && result.disposition).toBe('carried');
    expect(result.tourLog).toMatch(/carried/);
  });

  it('writes the unfinished jobs into Pending where the tour was carried (D-66)', async () => {
    writeProgress(
      renderOpenTourBlock({
        ...block,
        jobs: [
          { title: 'First job', criterion: 'a', status: 'done' },
          { title: 'Second job', criterion: 'b', status: 'pending' },
        ],
      }),
    );

    await close({ disposition: 'carried' });

    const progress = readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8');
    expect(progress).toMatch(/Second job/);
    expect(progress).not.toMatch(/## Pending\s*\n\s*\nnothing/);
  });

  it('refreshes the baseline, because the document root here is untracked', async () => {
    await close();

    const baseline = readDocBaseline(root);
    expect(baseline?.['SRS.md']?.version).toBe('1.3');
  });

  it('clears the open-tour block', async () => {
    await close();

    expect(readOpenTour(root, DOC_ROOT).kind).toBe('none');
    expect(readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8')).toContain(
      NO_OPEN_TOUR_STATEMENT,
    );
  });

  it('clears the failure record and the attempt counter at IDLE', async () => {
    writeLastFailure(root, {
      kind: 'verification',
      attempt: 1,
      command: 'npm run test',
      exitCode: 1,
      output: 'x',
    });

    const result = await close();

    expect(readLastFailure(root)).toBeNull();
    expect(result.marker.state).toBe('IDLE');
    expect(result.marker.attemptCount).toBe(0);
    expect(result.marker.tourId).toBeNull();
  });

  it('leaves the marker on disk equal to the one it returned', async () => {
    const result = await close();

    const read = readMarker(root);
    expect(read.kind === 'ok' && read.marker).toEqual(result.marker);
  });
});

describe('the closure commit is one commit, at its own occasion (D-76)', () => {
  it('reports the occasion the gate is to be asked about', async () => {
    const result = await close();

    expect(result.commitOccasion).toEqual({
      kind: 'closure',
      tourId: 'tour-9',
      state: 'CLOSING',
      disposition: 'closed',
    });
  });

  it('names CLOSING as the state, so the gate can refuse it anywhere else', async () => {
    const result = await close();

    expect(result.commitOccasion?.state).toBe('CLOSING');
  });

  it('creates no commit itself, because the gate is what decides that', async () => {
    const before = git('rev-list', '--all', '--count').trim();

    await close();

    expect(git('rev-list', '--all', '--count').trim()).toBe(before);
  });

  it('offers no occasion where a gate sent the closure away', async () => {
    writeReport(root, {
      ...report,
      debts: [{ document: 'SDD.md', section: '4.6', problem: 'unsettleable', settleable: false }],
    });

    const result = await close();

    expect(result.commitOccasion).toBeNull();
  });
});

describe('a carried tour hands its unfinished jobs to its successor (D-66)', () => {
  it('writes them into Pending, which is where the successor plans from', async () => {
    // The end of the route: the ceiling ends the tour at a boundary, the tour
    // travels VERIFYING to CLOSING with the disposition carried, and what it
    // did not finish lands where §4.1 reads it.
    writeProgress(
      renderOpenTourBlock({
        ...block,
        jobs: [
          { title: 'First job', criterion: 'the first thing holds', status: 'done' },
          { title: 'Second job', criterion: 'the second thing holds', status: 'pending' },
          { title: 'Third job', criterion: 'the third thing holds', status: 'pending' },
        ],
      }),
    );

    await close({ disposition: 'carried' });

    const progress = readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8');
    expect(progress).toMatch(/Carried from tour-9/);
    expect(progress).toMatch(/Second job: the second thing holds/);
    expect(progress).toMatch(/Third job: the third thing holds/);
    expect(progress).not.toMatch(/- {2}First job/);
  });

  it('leaves Pending alone for a tour that finished its list', async () => {
    const before = readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8');

    await close({ disposition: 'closed' });

    const after = readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8');
    expect(after).not.toMatch(/Carried from/);
    expect(before).toContain('nothing');
  });

  it('adds to Pending rather than replacing what was already waiting', async () => {
    // Pending is the owner's list as much as Wardroom's, and a closure that
    // overwrote it would delete whatever else was waiting there.
    writeProgress(
      renderOpenTourBlock({
        ...block,
        jobs: [{ title: 'Only job', criterion: 'a', status: 'pending' }],
      }),
    );
    const path = join(root, DOC_ROOT, 'PROGRESS.md');
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replace('nothing', '- something the owner wrote'),
    );

    await close({ disposition: 'carried' });

    const progress = readFileSync(path, 'utf8');
    expect(progress).toMatch(/something the owner wrote/);
    expect(progress).toMatch(/Only job/);
  });

  it('reaches IDLE by the ordinary route, with no gate raised', async () => {
    const result = await close({ disposition: 'carried' });

    expect(result.marker.state).toBe('IDLE');
    expect(list(root, { includeResolved: true })).toEqual([]);
  });
});
