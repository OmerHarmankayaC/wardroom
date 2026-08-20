import { defineConfig } from 'vitest/config';
import { ForwardFileOrderSequencer } from './tooling/reverse-sequencer.js';

/**
 * The first command of the green definition (SRS §3.4): the suite in forward
 * file order. The order is fixed by a sequencer rather than left to Vitest's
 * default heuristic so that the reversed run (vitest.reverse.config.ts) is the
 * reverse of a known order, not of an incidental one.
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    sequence: {
      sequencer: ForwardFileOrderSequencer,
    },
  },
});
