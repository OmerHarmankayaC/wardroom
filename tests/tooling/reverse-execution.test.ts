import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Evidence for the second command of the green definition (SRS §3.4): the
 * reversed run does not merely declare a sequencer, it executes the files in
 * reversed order. A unit test on the sequencer proves the ordering function;
 * this proves the ordering reaches the run (BACKLOG D-19).
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');

let workDir: string;
let logPath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'wardroom-order-'));
  logPath = join(workDir, 'order.log');
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Runs the fixture suite under one config and returns the execution order. */
function runFixtureSuite(config: string): string[] {
  execFileSync(process.execPath, [vitestBin, 'run', '--config', config], {
    cwd: repoRoot,
    env: { ...process.env, WARDROOM_ORDER_LOG: logPath, CI: 'true' },
    stdio: 'pipe',
  });
  return readFileSync(logPath, 'utf8').trim().split('\n');
}

describe('the reversed-order verify command', () => {
  it('executes the fixture files in ascending file order under the forward config', () => {
    const executed = runFixtureSuite('fixtures/reverse-order/vitest.forward.config.ts');

    expect(executed).toEqual(['01-alpha', '02-bravo', '03-charlie']);
  });

  it('executes the same files in descending file order under the reverse config', () => {
    const executed = runFixtureSuite('fixtures/reverse-order/vitest.reverse.config.ts');

    expect(executed).toEqual(['03-charlie', '02-bravo', '01-alpha']);
  });
});
