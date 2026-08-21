import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import {
  type LastFailure,
  clearLastFailure,
  failedRoute,
  readLastFailure,
  writeLastFailure,
} from '../../src/state/last-failure.js';

/**
 * `last-failure.json` (SDD §3.0, D-48, D-59).
 *
 * The failure the current attempt count was spent on, in one of two shapes.
 * One file rather than two, because one counter is spent by both (§3.2, D-60)
 * and the tour-budget gate reads whichever failure exhausted it.
 *
 * It exists because a process can die in `FAILED` or between planning
 * attempts, and re-running to reconstruct it is not equivalent: a re-run can
 * pass, leaving the owner asked to decide about a failure that no longer
 * reproduces.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-last-failure-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const verification: LastFailure = {
  kind: 'verification',
  attempt: 2,
  command: 'npm run test',
  exitCode: 1,
  output: '3 tests failed',
};

const planning: LastFailure = {
  kind: 'planning',
  attempt: 1,
  field: 'jobs',
  problem: 'the table has no rows',
};

describe('the record round-trips in both shapes', () => {
  it('keeps a verification failure whole', () => {
    writeLastFailure(root, verification);

    expect(readLastFailure(root)).toEqual(verification);
  });

  it('keeps a planning failure whole, naming the field that failed', () => {
    writeLastFailure(root, planning);

    expect(readLastFailure(root)).toEqual(planning);
  });

  it('writes the on-disk names SDD §3.0 uses', () => {
    writeLastFailure(root, verification);

    expect(JSON.parse(readFileSync(wardroomPaths(root).lastFailureFile, 'utf8'))).toEqual({
      kind: 'verification',
      attempt: 2,
      command: 'npm run test',
      exit_code: 1,
      output: '3 tests failed',
    });
  });

  it('keeps a silent failure, because a command can fail while printing nothing', () => {
    writeLastFailure(root, { ...verification, output: '' });

    expect(readLastFailure(root)).toMatchObject({ output: '' });
  });

  it('names the attempt it belongs to, in both shapes', () => {
    writeLastFailure(root, verification);
    expect(readLastFailure(root)?.attempt).toBe(2);

    writeLastFailure(root, planning);
    expect(readLastFailure(root)?.attempt).toBe(1);
  });
});

describe('the record is replaced, not accumulated', () => {
  it('holds the latest failure and no earlier one', () => {
    writeLastFailure(root, planning);
    writeLastFailure(root, verification);

    expect(readLastFailure(root)).toEqual(verification);
  });

  it('is cleared when the cycle reaches IDLE', () => {
    writeLastFailure(root, verification);

    clearLastFailure(root);

    expect(readLastFailure(root)).toBeNull();
  });

  it('is safe to clear when there was never one', () => {
    expect(() => clearLastFailure(root)).not.toThrow();
    expect(readLastFailure(root)).toBeNull();
  });
});

describe('an unusable record is an absence, not a guess', () => {
  it('answers null for a repository that has never failed', () => {
    expect(readLastFailure(root)).toBeNull();
  });

  it('answers null rather than half a record', () => {
    // §4.4's FAILED branch re-runs verification when the record is absent
    // rather than guessing which side of the budget the tour was on, and a
    // record it cannot read has to reach that branch the same way.
    writeFileSync(wardroomPaths(root).lastFailureFile, '{"kind":"verific');

    expect(readLastFailure(root)).toBeNull();
  });

  it('answers null for a shape that is neither of the two', () => {
    writeFileSync(
      wardroomPaths(root).lastFailureFile,
      JSON.stringify({ kind: 'lint', attempt: 1 }),
    );

    expect(readLastFailure(root)).toBeNull();
  });

  it('answers null for a record missing the field its shape requires', () => {
    writeFileSync(
      wardroomPaths(root).lastFailureFile,
      JSON.stringify({ kind: 'planning', attempt: 1, field: 'jobs' }),
    );

    expect(readLastFailure(root)).toBeNull();
  });
});

describe('the record says what FAILED does next, in one place (§4.4 step 4)', () => {
  it('retries while the count is under the budget', () => {
    expect(failedRoute(1, 2, verification)).toBe('retry');
  });

  it('raises the gate once the count reaches it', () => {
    expect(failedRoute(2, 2, verification)).toBe('gate');
  });

  it('re-verifies where no record survives, rather than guessing', () => {
    // With no evidence there is nothing to say which side of the budget the
    // tour was on, and either guess is worse than looking again. The absent
    // record decides this, not the counter, which is why the counter alone is
    // not enough to answer.
    expect(failedRoute(2, 2, null)).toBe('reverify');
    expect(failedRoute(0, 2, null)).toBe('reverify');
  });

  it('answers the same for a planning record, which spends the same counter', () => {
    expect(failedRoute(2, 2, planning)).toBe('gate');
  });
});
