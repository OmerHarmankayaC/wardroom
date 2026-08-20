import { appendFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Fixture for tests/tooling/reverse-execution.test.ts. Not part of Wardroom's
 * own suite: the root config collects test files under `tests/` only. Each
 * file records the fact that it ran, so the recorded sequence is the evidence
 * that a configured file order was actually executed (SRS §3.4, D-19).
 */
it('records that 01-alpha executed', () => {
  const log = process.env.WARDROOM_ORDER_LOG;
  expect(log, 'WARDROOM_ORDER_LOG must be set by the spawning test').toBeTruthy();
  appendFileSync(log as string, '01-alpha\n');
});
