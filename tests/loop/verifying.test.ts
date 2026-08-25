import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { list } from '../../src/gates/queue.js';
import { driveFailed, driveVerifying } from '../../src/loop/verifying.js';
import { readLastFailure, writeLastFailure } from '../../src/state/last-failure.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';
import type { VerificationResult, VerifyRunner } from '../../src/verify/run.js';

/**
 * `VERIFYING` and `FAILED` (SDD §3.2, §4.3, §4.4 step 4, D-48, D-59, D-71).
 *
 * The `VERIFYING` run is the orchestrator's own and is over the tour rather
 * than the job; it alone moves the state machine and spends the budget (D-58).
 * What it leaves behind on a failure is the record both the retry and the
 * gate's preview read, because a re-run to reconstruct it is not equivalent: a
 * re-run can pass, leaving the owner asked about a failure that no longer
 * reproduces.
 */

let root: string;

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: 'internal/docs',
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['npm run test'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 2,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

const VERIFYING_MARKER: StateMarker = {
  state: 'VERIFYING',
  tourId: 'tour-9',
  jobIndex: 3,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  disposition: null,
  headCommit: null,
  updatedAt: '2026-08-21T09:00:00.000Z',
};

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

const green: VerifyRunner = () => ({ kind: 'green', ran: ['npm run test'] });

function failing(output = '3 tests failed'): VerifyRunner {
  return () => ({
    kind: 'failed',
    failure: { command: 'npm run test', exitCode: 1, output },
    ran: ['npm run test'],
  });
}

const noDefinition: VerifyRunner = () => ({
  kind: 'no-definition',
  reason: 'the project contract carries no `verify` commands',
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-verifying-'));
  ensureRunDir(root);
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  writeMarker(root, VERIFYING_MARKER);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function verify(runVerification: VerifyRunner, marker = VERIFYING_MARKER) {
  return driveVerifying({ root, config, marker, disposition: 'closed', runVerification, now: NOW });
}

describe('green exits to CLOSING', () => {
  it('moves the state and leaves the counter alone', () => {
    const result = verify(green, { ...VERIFYING_MARKER, attemptCount: 1 });

    expect(result.kind).toBe('green');
    expect(result.marker.state).toBe('CLOSING');
    expect(result.marker.attemptCount).toBe(1);
  });

  it('writes no failure record, and clears none either', () => {
    // The record is cleared when the cycle reaches IDLE (§3.2, §4.6 step 7),
    // not when a run finally passes: the tour log still has to say what the
    // attempts were spent on.
    writeLastFailure(root, {
      kind: 'verification',
      attempt: 1,
      command: 'npm run test',
      exitCode: 1,
      output: 'earlier',
    });

    verify(green, { ...VERIFYING_MARKER, attemptCount: 1 });

    expect(readLastFailure(root)?.attempt).toBe(1);
  });

  it('refuses to drive from a state that is not VERIFYING', () => {
    expect(() => verify(green, { ...VERIFYING_MARKER, state: 'EXECUTING' })).toThrowError(
      /VERIFYING/,
    );
  });
});

describe('a failure records what it was, counts, and enters FAILED', () => {
  it('writes the verification record with the failing command', () => {
    verify(failing());

    const record = readLastFailure(root);
    expect(record).toEqual({
      kind: 'verification',
      attempt: 1,
      command: 'npm run test',
      exitCode: 1,
      output: '3 tests failed',
    });
  });

  it('keeps a silent failure, because a command can fail while printing nothing', () => {
    verify(failing(''));

    expect(readLastFailure(root)).toMatchObject({ output: '' });
  });

  it('increments the counter and enters FAILED', () => {
    const result = verify(failing());

    expect(result.kind).toBe('failed');
    expect(result.marker.state).toBe('FAILED');
    expect(result.marker.attemptCount).toBe(1);
  });

  it('names the attempt the record belongs to', () => {
    verify(failing(), { ...VERIFYING_MARKER, attemptCount: 1 });

    expect(readLastFailure(root)?.attempt).toBe(2);
  });

  it('runs the project own verify list, not a list of its own', () => {
    const seen: (readonly string[])[] = [];
    driveVerifying({
      root,
      config: { ...config, verify: ['a', 'b'] },
      marker: VERIFYING_MARKER,
      disposition: 'closed',
      runVerification: (_root, commands) => {
        seen.push(commands);
        return { kind: 'green', ran: [...commands] };
      },
      now: NOW,
    });

    expect(seen).toEqual([['a', 'b']]);
  });
});

describe('a missing definition raises the gate at once, without a retry (D-71)', () => {
  it('does not enter FAILED and does not spend an attempt at a time', () => {
    const result = verify(noDefinition);

    expect(result.kind).toBe('gated');
    expect(result.marker.state).toBe('GATED');
    expect(result.marker.attemptCount).toBe(0);
  });

  it('carries its reason as the evidence the owner decides on', () => {
    verify(noDefinition);

    const preview = list(root)[0]?.preview;
    expect(preview?.kind).toBe('tour-budget');
    // No attempt was spent, so there is no record to carry, and the reason
    // travels in the entry's why line instead (D-71, D-81).
    expect(preview?.kind === 'tour-budget' && preview.failure).toBeNull();
    expect(list(root)[0]?.why).toMatch(/no .?verify/);
  });

  it('names the tour, because this one is raised from inside it', () => {
    verify(noDefinition);

    expect(list(root)[0]?.tourId).toBe('tour-9');
    expect(list(root)[0]?.interruptedState).toBe('VERIFYING');
  });

  it('is not a pass, whatever else it is (FR-1.5)', () => {
    expect(verify(noDefinition).kind).not.toBe('green');
  });
});

describe('FAILED re-derives from the record, never from memory (§4.4)', () => {
  const failedMarker: StateMarker = { ...VERIFYING_MARKER, state: 'FAILED', attemptCount: 1 };

  function resumeFailed(marker: StateMarker) {
    writeMarker(root, marker);
    return driveFailed({ root, config, marker, now: NOW });
  }

  it('retries into EXECUTING while the count is under the budget', () => {
    writeLastFailure(root, {
      kind: 'verification',
      attempt: 1,
      command: 'npm run test',
      exitCode: 1,
      output: 'a failure a fresh process never saw',
    });

    const result = resumeFailed(failedMarker);

    expect(result.kind).toBe('retry');
    expect(result.marker.state).toBe('EXECUTING');
    expect(
      result.kind === 'retry' && result.failure.kind === 'verification' && result.failure.output,
    ).toContain('never saw');
  });

  it('raises the tour-budget gate once the count reaches the budget', () => {
    writeLastFailure(root, {
      kind: 'verification',
      attempt: 2,
      command: 'npm run test',
      exitCode: 1,
      output: '3 tests failed',
    });

    const result = resumeFailed({ ...failedMarker, attemptCount: 2 });

    expect(result.kind).toBe('gated');
    expect(result.marker.state).toBe('GATED');
    const preview = list(root)[0]?.preview;
    expect(
      preview?.kind === 'tour-budget' &&
        preview.failure?.kind === 'verification' &&
        preview.failure.output,
    ).toMatch(/3 tests failed/);
    expect(preview?.kind === 'tour-budget' && preview.attemptCount).toBe(2);
  });

  it('re-runs verification where the record is absent, rather than guessing', () => {
    // §4.4: with no record there is nothing to decide which side of the budget
    // the tour was on, and guessing either way is worse than looking again.
    const result = resumeFailed({ ...failedMarker, attemptCount: 2 });

    expect(result.kind).toBe('reverify');
    expect(result.marker.state).toBe('VERIFYING');
  });

  it('re-runs verification where the record cannot be read', () => {
    writeLastFailure(root, {
      kind: 'verification',
      attempt: 1,
      command: 'npm run test',
      exitCode: 1,
      output: 'x',
    });
    // Half a record is the same answer as none: readLastFailure says null.
    execFileSync('sh', ['-c', `printf '{"kind":"verif' > ${wardroomPaths(root).lastFailureFile}`]);

    expect(resumeFailed({ ...failedMarker, attemptCount: 2 }).kind).toBe('reverify');
  });

  it('reads the record from disk and not from the run that wrote it', () => {
    // The whole point of D-48: a process died in FAILED, and this one has no
    // memory of the failure. Everything it decides from is on disk.
    writeLastFailure(root, {
      kind: 'planning',
      attempt: 2,
      field: 'jobs',
      problem: 'the table has no rows',
    });

    const result = resumeFailed({ ...failedMarker, attemptCount: 2 });

    expect(result.kind).toBe('gated');
    const preview = list(root)[0]?.preview;
    // The record in its own shape, so the owner sees which field failed and
    // why, rather than one sentence with both flattened into it (D-81).
    expect(preview?.kind === 'tour-budget' && preview.failure).toMatchObject({
      kind: 'planning',
      field: expect.any(String),
      problem: expect.any(String),
    });
  });

  it('refuses to drive from a state that is not FAILED', () => {
    expect(() => resumeFailed({ ...failedMarker, state: 'CLOSING' })).toThrowError(/FAILED/);
  });

  it('leaves the marker on disk equal to the one it returned', () => {
    writeLastFailure(root, {
      kind: 'verification',
      attempt: 1,
      command: 'npm run test',
      exitCode: 1,
      output: 'x',
    });

    const result = resumeFailed(failedMarker);

    const read = readMarker(root);
    expect(read.kind === 'ok' && read.marker).toEqual(result.marker);
  });
});
