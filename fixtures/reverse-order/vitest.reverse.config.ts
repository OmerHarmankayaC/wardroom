import { defineConfig } from 'vitest/config';
import { ReversedFileOrderSequencer } from '../../tooling/reverse-sequencer.js';

export default defineConfig({
  test: {
    dir: import.meta.dirname,
    include: ['*.spec.ts'],
    fileParallelism: false,
    sequence: { sequencer: ReversedFileOrderSequencer },
  },
});
