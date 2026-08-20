import { defineConfig } from 'vitest/config';
import { ForwardFileOrderSequencer } from '../../tooling/reverse-sequencer.js';

export default defineConfig({
  test: {
    dir: import.meta.dirname,
    include: ['*.spec.ts'],
    fileParallelism: false,
    sequence: { sequencer: ForwardFileOrderSequencer },
  },
});
