import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { list } from '../../src/gates/queue.js';
import { drivePlanning } from '../../src/loop/planning.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { readLastFailure } from '../../src/state/last-failure.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';

/**
 * The `PLANNING` drive (SDD §3.2, §4.1, §4.4 step 4, D-49, D-50, D-59, D-60).
 *
 * Planning is where the tour record is created and its identifier minted, so
 * everything before the block is written happens under no tour at all. That is
 * what makes the failure route here different from the one out of `VERIFYING`:
 * there is nothing to abandon, and the gate it eventually raises names no tour.
 */

/** Write traffic through Wardroom's one write primitive, called through. */
const writes: string[] = [];
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/fs/atomic.js')>();
  return {
    ...real,
    atomicWriteFile: (target: string, contents: string) => {
      writes.push(target);
      real.atomicWriteFile(target, contents);
    },
  };
});

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
  goal: 'Prove planning plans.',
  basedOn: 'CHARTER 1.3, SRS 1.12, SDD 1.13, BACKLOG 1.15',
  opened: '2026-08-21',
  jobs: [{ title: 'First job', criterion: 'the first thing holds', status: 'pending' }],
  doNotTouch: 'anything else',
  stopConditions: 'a large deviation',
};

const PLANNING_MARKER: StateMarker = {
  state: 'PLANNING',
  tourId: null,
  jobIndex: null,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  headCommit: null,
  updatedAt: '2026-08-21T09:00:00.000Z',
};

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

function writeProgress(body: string): void {
  const path = join(root, DOC_ROOT, 'PROGRESS.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    ['# PROGRESS', '', '## Open tour', '', body, '', '## Done', '', 'none', ''].join('\n'),
  );
}

function markerWrites(): number {
  return writes.filter((target) => target === wardroomPaths(root).stateFile).length;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-planning-'));
  ensureRunDir(root);
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeProgress(NO_OPEN_TOUR_STATEMENT);
  writeMarker(root, PLANNING_MARKER);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A PM session that writes whatever the test tells it to. It stands in for the
 * SDK session, which needs an API key and a network this suite must not need.
 */
function session(...attempts: readonly (OpenTourBlock | string)[]) {
  const ran: number[] = [];
  let attempt = 0;
  return {
    ran,
    session: {
      plan: async () => {
        const output = attempts[Math.min(attempt, attempts.length - 1)] as OpenTourBlock | string;
        ran.push(attempt);
        attempt += 1;
        writeProgress(typeof output === 'string' ? output : renderOpenTourBlock(output));
      },
    },
  };
}

function drive(pm: { plan: () => Promise<void> }, marker = PLANNING_MARKER) {
  return drivePlanning({ root, config, marker, session: pm, now: NOW });
}

describe('a plan that parses completes into EXECUTING', () => {
  it('runs the session and adopts what it wrote', async () => {
    const { ran, session: pm } = session(block);

    const result = await drive(pm);

    expect(ran).toEqual([0]);
    expect(result.kind).toBe('planned');
    expect(result.marker.state).toBe('EXECUTING');
  });

  it('takes the tour identifier from the block, which is where it is minted', async () => {
    const result = await drive(session(block).session);

    // §4.1 step 7: the block is where the identifier is minted (§3.3, D-45).
    // Before it, planning ran under no tour at all.
    expect(result.marker.tourId).toBe('tour-9');
    expect(PLANNING_MARKER.tourId).toBeNull();
  });

  it('leaves the marker on disk equal to the one it returned', async () => {
    const result = await drive(session(block).session);

    const read = readMarker(root);
    expect(read.kind === 'ok' && read.marker).toEqual(result.marker);
  });

  it('writes no failure record when nothing failed', async () => {
    await drive(session(block).session);

    expect(readLastFailure(root)).toBeNull();
  });

  it('refuses to drive from a state that is not PLANNING', async () => {
    await expect(
      drive(session(block).session, { ...PLANNING_MARKER, state: 'EXECUTING' }),
    ).rejects.toThrowError(/PLANNING/);
  });
});

describe('a complete block already on disk is adopted, not re-planned (D-49)', () => {
  it('does not run the session at all', async () => {
    // §4.1 step 7 writes the block before the marker, so a finished plan under
    // a PLANNING marker is the ordinary outcome of a death at that seam.
    writeProgress(renderOpenTourBlock(block));
    const { ran, session: pm } = session(block);

    const result = await drive(pm);

    expect(ran).toEqual([]);
    expect(result.kind).toBe('planned');
    expect(result.marker.tourId).toBe('tour-9');
  });

  it('re-plans where the block is only partly written', async () => {
    writeProgress('### Tour 9\n\n- **Goal:** half a block and no table\n');
    const { ran, session: pm } = session(block);

    const result = await drive(pm);

    expect(ran).toEqual([0]);
    expect(result.kind).toBe('planned');
  });

  it('re-plans where no block is there at all', async () => {
    const { ran, session: pm } = session(block);

    await drive(pm);

    expect(ran).toEqual([0]);
  });
});

describe('a plan that does not parse is a failed attempt (D-50)', () => {
  it('writes a planning record naming the field that failed', async () => {
    const { session: pm } = session('### Tour 9\n\n- **Goal:** no table here\n', block);

    await drive(pm);

    // The record is replaced at the next failure and cleared at IDLE, so what
    // survives here is the last one, from attempt 1.
    const failure = readLastFailure(root);
    expect(failure?.kind).toBe('planning');
    expect(failure?.attempt).toBe(1);
    expect(failure?.kind === 'planning' && failure.field).not.toBe('');
  });

  it('increments the counter and plans again while it is under budget', async () => {
    const { ran, session: pm } = session('nonsense', block);

    const result = await drive(pm);

    expect(ran).toEqual([0, 1]);
    expect(result.kind).toBe('planned');
    expect(result.marker.attemptCount).toBe(1);
  });

  it('carries the counter into the tour, so a plan that cost attempts says so', async () => {
    const { session: pm } = session('nonsense', block);

    const result = await drive(pm);

    // D-60: the counter belongs to the cycle. It is not refreshed by a
    // successful plan, only by IDLE or an approved tour-budget gate.
    expect(result.marker.attemptCount).toBe(1);
  });
});

describe('exhaustion raises the tour-budget gate, naming no tour (D-50, D-70)', () => {
  it('stops planning and raises the gate', async () => {
    const { ran, session: pm } = session('nonsense');

    const result = await drive(pm);

    expect(ran).toEqual([0, 1]);
    expect(result.kind).toBe('gated');
    expect(result.marker.state).toBe('GATED');
  });

  it('names no tour, because planning never created one', async () => {
    const { session: pm } = session('nonsense');

    await drive(pm);

    const entry = list(root)[0];
    expect(entry?.gateClass).toBe('tour-budget');
    expect(entry?.tourId).toBeNull();
    expect(entry?.interruptedState).toBe('PLANNING');
  });

  it('carries the parse failure as the evidence the owner decides on', async () => {
    const { session: pm } = session('nonsense');

    await drive(pm);

    const preview = list(root)[0]?.preview;
    expect(preview?.kind).toBe('tour-budget');
    expect(preview?.kind === 'tour-budget' && preview.attemptCount).toBe(2);
    expect(preview?.kind === 'tour-budget' && preview.lastFailureOutput).toMatch(/did not parse/);
  });

  it('raises the gate without planning again where the budget is already spent', async () => {
    // §4.4's PLANNING branch: the counter survives the death and a re-plan does
    // not refresh it, so resumption at the budget raises the gate rather than
    // spending an attempt that was never available.
    const { ran, session: pm } = session(block);

    const result = await drive(pm, { ...PLANNING_MARKER, attemptCount: 2 });

    expect(ran).toEqual([]);
    expect(result.kind).toBe('gated');
  });

  it('marks the marker with the gate it waits on', async () => {
    const { session: pm } = session('nonsense');

    const result = await drive(pm);

    expect(result.marker.gateId).toBe(list(root)[0]?.gateId);
    expect(result.marker.interruptedState).toBe('PLANNING');
  });
});

describe('the marker moves once per transition', () => {
  it('writes one marker for a plan that parsed first time', async () => {
    const before = markerWrites();

    await drive(session(block).session);

    expect(markerWrites() - before).toBe(1);
  });

  it('writes one per failed attempt and one for the gate', async () => {
    const before = markerWrites();

    await drive(session('nonsense').session);

    // Two failed attempts and the raise: three transitions, three writes.
    expect(markerWrites() - before).toBe(3);
  });
});

describe('the loop cannot spin, whatever the counter does', () => {
  it.each([1, 2, 3])('spends exactly the budget of %i and no more', async (attemptBudget) => {
    // Every exit above depends on attempt_count moving. A counter that stopped
    // moving would turn this into the unbounded retry FR-1.3 and D-50 exist to
    // forbid, with no gate raised and nothing on disk saying why. This pins the
    // count the loop actually spends; the floor inside it is the second line,
    // independent of the counter, for a defect that would make this hang.
    const { ran, session: pm } = session('nonsense');

    const result = await drivePlanning({
      root,
      config: { ...config, attemptBudget },
      marker: PLANNING_MARKER,
      session: pm,
      now: NOW,
    });

    expect(ran).toHaveLength(attemptBudget);
    expect(result.kind).toBe('gated');
    expect(result.marker.attemptCount).toBe(attemptBudget);
  });
});
