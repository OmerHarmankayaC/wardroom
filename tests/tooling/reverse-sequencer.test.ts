import { describe, expect, it } from 'vitest';
import type { TestSpecification, Vitest } from 'vitest/node';
import {
  ForwardFileOrderSequencer,
  ReversedFileOrderSequencer,
} from '../../tooling/reverse-sequencer.js';

/**
 * The green definition (SRS §3.4) requires the suite to run a second time in
 * reversed file order. These tests are the evidence that the second run is a
 * run and not a claim (SDD §2, BACKLOG D-19).
 */

/** Minimal stand-in for the only field `sort` reads. */
function spec(moduleId: string): TestSpecification {
  return { moduleId } as TestSpecification;
}

/** `sort` never touches the Vitest context; only `shard` does. */
const noContext = {} as Vitest;

const unordered = [
  spec('/repo/tests/state/resume.test.ts'),
  spec('/repo/tests/config/load.test.ts'),
  spec('/repo/tests/tooling/reverse-sequencer.test.ts'),
  spec('/repo/tests/config/tracking.test.ts'),
];

describe('file-order sequencers', () => {
  it('orders test files by module path ascending', async () => {
    const sorted = await new ForwardFileOrderSequencer(noContext).sort(unordered);

    expect(sorted.map((file) => file.moduleId)).toEqual([
      '/repo/tests/config/load.test.ts',
      '/repo/tests/config/tracking.test.ts',
      '/repo/tests/state/resume.test.ts',
      '/repo/tests/tooling/reverse-sequencer.test.ts',
    ]);
  });

  it('returns files in exactly the reverse of the forward order', async () => {
    const forward = await new ForwardFileOrderSequencer(noContext).sort(unordered);
    const reversed = await new ReversedFileOrderSequencer(noContext).sort(unordered);

    expect(reversed.map((file) => file.moduleId)).toEqual(
      forward.map((file) => file.moduleId).reverse(),
    );
  });

  it('does not mutate the list it was given', async () => {
    const input = [...unordered];

    await new ReversedFileOrderSequencer(noContext).sort(input);

    expect(input.map((file) => file.moduleId)).toEqual(unordered.map((file) => file.moduleId));
  });
});
