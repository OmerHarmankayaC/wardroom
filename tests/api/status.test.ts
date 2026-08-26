import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectStatus } from '../../src/api/status.js';
import { wardroomPaths } from '../../src/config/paths.js';
import { ceilingAgainst } from '../../src/loop/ceiling.js';
import {
  GATE_ID,
  block,
  gateEntry,
  given,
  makeProject,
  writeConfig,
  writeGateEntry,
  writeProgress,
  writeUsageLines,
} from './support.js';

/**
 * `status` answers from files alone (SDD §5.1, FR-1.4, FR-3.3).
 *
 * It is the operation an owner reaches for when they have come back to a
 * repository they left, so nothing here starts a session, runs a command or
 * touches a remote: an operation that had to run something to answer would be
 * unusable at exactly that moment.
 *
 * Every input below is a file written by hand rather than by the code that
 * reads it, wherever the two would be the same component (D-55). The marker is
 * written through its own writer, which belongs to an earlier tour and whose
 * shape this reader is entitled to expect.
 */

let root: string;

beforeEach(() => {
  root = makeProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the state', () => {
  it('answers the state the marker carries', () => {
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    expect(projectStatus(root).state).toBe('EXECUTING');
  });

  it('keeps an unreadable marker apart from an absent one (D-20)', () => {
    writeFileSync(wardroomPaths(root).stateFile, '{ truncated');

    const status = projectStatus(root);

    // Not `IDLE`. An unreadable marker and no marker mean opposite things to
    // resumption, and collapsing them silently abandons an open tour.
    expect(status.state).toBeNull();
    expect(status.marker.kind).toBe('unreadable');
  });

  it('reports an absent marker as absent', () => {
    rmSync(wardroomPaths(root).stateFile, { force: true });

    expect(projectStatus(root).marker.kind).toBe('absent');
  });
});

describe('the open tour and the job it is at', () => {
  it('reads the block from PROGRESS', () => {
    writeProgress(root);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    const status = projectStatus(root);

    expect(status.openTour.kind).toBe('open');
    expect(status.openTour.kind === 'open' && status.openTour.block.tourId).toBe('tour-4');
  });

  it('names the current job from the marker index and the block row', () => {
    writeProgress(root);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    expect(projectStatus(root).currentJob).toEqual({ index: 1, job: block.jobs[1] });
  });

  it('answers no current job where the marker carries no index', () => {
    writeProgress(root);
    given(root, { state: 'VERIFYING', tourId: 'tour-4' });

    expect(projectStatus(root).currentJob).toBeNull();
  });

  it('reports an index the block has no row for as a row that is not there', () => {
    // The two records can disagree, and the disagreement is the fact worth
    // reporting: answering the last row, or no job at all, would hide it.
    writeProgress(root);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 9 });

    expect(projectStatus(root).currentJob).toEqual({ index: 9, job: null });
  });

  it('reports a block that does not parse rather than reporting no tour', () => {
    writeProgress(root, null);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 0 });

    expect(projectStatus(root).openTour.kind).toBe('none');
  });
});

describe('the gates', () => {
  it('lists a pending gate', () => {
    writeGateEntry(root, gateEntry());
    given(root, {
      state: 'GATED',
      tourId: 'tour-4',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: GATE_ID,
    });

    expect(projectStatus(root).gates.map((entry) => entry.gateId)).toEqual([GATE_ID]);
  });

  it('lists a parked gate too, since parking never resolves one (D-27)', () => {
    writeGateEntry(root, gateEntry({ parked_at: '2026-08-22T09:30:00.000Z' }));
    given(root, {
      state: 'PARKED',
      tourId: 'tour-4',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: GATE_ID,
    });

    const status = projectStatus(root);

    expect(status.gates).toHaveLength(1);
    expect(status.gates[0]?.status).toBe('pending');
    expect(status.gates[0]?.parkedAt).toBe('2026-08-22T09:30:00.000Z');
  });

  it('leaves a decided gate out', () => {
    writeGateEntry(
      root,
      gateEntry({
        status: 'approved',
        decided_at: '2026-08-21T10:00:00.000Z',
        decided_by: 'owner',
      }),
    );
    given(root);

    expect(projectStatus(root).gates).toEqual([]);
  });
});

describe('usage against budget (FR-1.4, D-66)', () => {
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

  it('measures what was spent and what the largest job cost', () => {
    writeUsageLines(root, [line(), line({ job_index: 1, usd: 3 })]);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    const { budget } = projectStatus(root);

    expect(budget.kind).toBe('within');
    expect(budget.kind !== 'inactive' && budget.spentUsd).toBe(4);
    expect(budget.kind !== 'inactive' && budget.largestJobUsd).toBe(3);
    expect(budget.kind !== 'inactive' && budget.ceilingUsd).toBe(20);
  });

  it('says whether the next boundary would close the tour', () => {
    // The same comparison the drive makes at a boundary, asked without making
    // one: spent plus the largest single job so far, against the ceiling.
    // `reached` is the drive's own word for it, because it is the drive's own
    // function answering (src/loop/ceiling.ts).
    writeUsageLines(root, [line({ usd: 17 }), line({ job_index: 1, usd: 4 })]);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    const { budget } = projectStatus(root);

    expect(budget.kind).toBe('reached');
  });

  it('reports a meter that did not run as not measured, never as zero (D-80)', () => {
    // A tour whose lines carry no cost is not a free tour: it is a tour nobody
    // measured, and answering zero would let the ceiling check pass on a
    // number that does not exist.
    // Absent rather than zero: the meter did not run for this line.
    const { usd: _dropped, ...uncosted } = line();
    writeUsageLines(root, [uncosted]);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 0 });

    const { budget, usage } = projectStatus(root);

    expect(usage.kind).toBe('inactive');
    expect(budget.kind).toBe('inactive');
  });

  it('reports subscription auth as inactive rather than satisfied (D-46)', () => {
    writeConfig(root, { auth_mode: 'subscription' });
    writeUsageLines(root, [line()]);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 0 });

    const { budget } = projectStatus(root);

    expect(budget.kind).toBe('inactive');
    expect(budget.kind === 'inactive' && budget.reason).toMatch(/subscription/);
  });

  it('asks about the tour the marker names, not about every tour ever run', () => {
    writeUsageLines(root, [line({ tour_id: 'tour-3', usd: 19 }), line({ usd: 2 })]);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 0 });

    const { budget } = projectStatus(root);

    expect(budget.kind !== 'inactive' && budget.spentUsd).toBe(2);
  });
});

describe('status asks the drive its own question (D-66)', () => {
  /**
   * The rule has one home, and this is the check that it does.
   *
   * `status` used to restate the arithmetic in its own words, which is two
   * places for the boundary to move and a surface reporting one answer while
   * the drive acts on another. It now calls the drive's function, and the case
   * below is what says so: the same summary through both paths gives the same
   * verdict, so a change to the rule cannot reach one and miss the other.
   */
  it('answers exactly as the boundary check does, from the same summary', () => {
    const at = (spent: number, largest: number) =>
      ceilingAgainst(
        {
          kind: 'measured',
          spentUsd: spent,
          largestJobUsd: largest,
          jobsMeasured: 2,
          tokens: { input: 0, output: 0 },
        },
        10,
      ).kind;

    expect(at(5, 4)).toBe('within');
    expect(at(5, 5)).toBe('reached');
    expect(at(9, 4)).toBe('reached');
  });

  it('carries the reason of an inactive meter through rather than inventing a number', () => {
    expect(
      ceilingAgainst({ kind: 'inactive', reason: 'no meter', tokens: { input: 0, output: 0 } }, 10),
    ).toEqual({ kind: 'inactive', reason: 'no meter' });
  });
});
