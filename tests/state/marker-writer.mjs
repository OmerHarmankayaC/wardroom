// Child process for tests/state/kill.test.ts. Writes markers in a tight loop
// until it is killed, using the shipped writeMarker — the point of the test is
// that the real implementation survives a SIGKILL, so nothing here reimplements
// it. Runs against dist/ so it needs no TypeScript loader on Node 18.
import { ensureRunDir } from '../../dist/config/paths.js';
import { writeMarker } from '../../dist/state/marker.js';

const root = process.argv[2];
ensureRunDir(root);

let attempt = 0;
for (;;) {
  writeMarker(root, {
    state: 'EXECUTING',
    tourId: 'tour-1',
    jobIndex: 1,
    interruptedState: null,
    attemptCount: attempt++,
    headCommit: '0123456789abcdef0123456789abcdef01234567',
    updatedAt: new Date().toISOString(),
  });
}
