import { defineConfig } from 'vitest/config';
import { ReversedFileOrderSequencer } from './tooling/reverse-sequencer.js';

/**
 * The second command of the green definition (SRS §3.4): the same suite in
 * reversed file order, which is how silent order dependencies between test
 * files are caught. `fileParallelism` is off so the configured order is the
 * order that actually runs, not a scheduling hint (SDD §2, BACKLOG D-19).
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    sequence: {
      sequencer: ReversedFileOrderSequencer,
    },
  },
});
