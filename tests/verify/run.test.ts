import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVerification } from '../../src/verify/run.js';

/**
 * The green definition run (SDD §4.3, SRS §3.4, FR-1.5).
 *
 * One runner, two callers: the commit gate runs it at every job boundary and
 * `VERIFYING` runs it over the tour. Only the second moves the state machine
 * (D-58). What is here is the run itself, which knows about neither.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-verify-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the commands run in order and the first failure ends the run', () => {
  it('reports green when every command exits zero', () => {
    const result = runVerification(root, ['exit 0', 'true']);

    expect(result.kind).toBe('green');
    expect(result.kind === 'green' && result.ran).toEqual(['exit 0', 'true']);
  });

  it('stops at the first non-zero exit and names the command', () => {
    const result = runVerification(root, ['true', 'exit 3', 'true']);

    expect(result.kind).toBe('failed');
    if (result.kind !== 'failed') return;
    expect(result.failure.command).toBe('exit 3');
    expect(result.failure.exitCode).toBe(3);
    expect(result.ran).toEqual(['true', 'exit 3']);
  });

  it('does not run a command after the one that failed', () => {
    // The marker file would exist if the third command had run. An ordered
    // list whose tail runs anyway is not an ordered list, and a lint pass
    // after a failing suite wastes the time the ordering exists to save.
    const witness = join(root, 'ran-the-third');
    const result = runVerification(root, ['true', 'exit 1', `touch ${witness}`]);

    expect(result.kind).toBe('failed');
    expect(runVerification(root, [`test ! -e ${witness}`]).kind).toBe('green');
  });

  it('captures the failing command output, which is the evidence a retry reads', () => {
    const result = runVerification(root, ['echo "3 tests failed" >&2; exit 1']);

    expect(result.kind === 'failed' && result.failure.output).toContain('3 tests failed');
  });

  it('keeps a silent failure, because a command can fail while printing nothing', () => {
    const result = runVerification(root, ['exit 7']);

    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.failure.output).toBe('');
  });

  it('runs in the project root', () => {
    const result = runVerification(root, [`test "$(pwd -P)" = "$(cd ${root} && pwd -P)"`]);

    expect(result.kind).toBe('green');
  });
});

describe('a run that could not happen says so', () => {
  it('reports a command that could not be started, rather than an empty failure', () => {
    // A shell that cannot start leaves no output of its own, and a failure
    // whose evidence is an empty string is a failure nobody can act on. The
    // spawn error is the only account of what happened, so it is kept.
    const result = runVerification(join(root, 'no-such-directory'), ['true']);

    expect(result.kind).toBe('failed');
    expect(result.kind === 'failed' && result.failure.output).not.toBe('');
  });
});

describe('a missing definition is a failure, never a pass (FR-1.5)', () => {
  it.each([[[]], [undefined]])('refuses %s with the reason stated', (commands) => {
    const result = runVerification(root, commands as readonly string[]);

    expect(result.kind).toBe('no-definition');
    expect(result.kind === 'no-definition' && result.reason).toMatch(/verify/);
  });

  it('is not green, which is the whole point of naming it separately', () => {
    // A guessed test command that happens to exit zero would report green for
    // a suite that never ran, which is worse than no verification at all
    // (SDD §4.3). So is an empty list read as "nothing failed".
    expect(runVerification(root, []).kind).not.toBe('green');
  });
});
