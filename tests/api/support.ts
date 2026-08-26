import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { type OpenTourBlock, renderOpenTourBlock } from '../../src/progress/open-tour.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';

/**
 * A project on disk for the API tests to read.
 *
 * The fixture writes the files by hand rather than through the modules the
 * operations read them with, wherever the two would be the same code: a
 * criterion satisfied by round-tripping one component's own output cannot see
 * an assumption both halves share (D-55). The marker is the exception and is
 * written through its writer, because the writer is not part of this job and
 * its shape is what the reader is entitled to expect.
 */

export const DOC_ROOT = 'internal/docs';

export function makeProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'wardroom-api-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  ensureRunDir(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'f@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  writeConfig(root);
  writeFile(root, 'README.md', '# fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

export function writeFile(root: string, path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

export function writeConfig(root: string, overrides: Record<string, unknown> = {}): void {
  writeFile(
    root,
    '.wardroom/config.json',
    `${JSON.stringify(
      {
        name: 'example',
        level: 'full',
        doc_root: DOC_ROOT,
        default_branch: 'main',
        stack: { language: 'TypeScript', runtime: 'node>=18', package_manager: 'npm' },
        verify: ['true'],
        auth_mode: 'api_key',
        gate_wait: '24h',
        attempt_budget: 3,
        usage_budget: { usd: 20 },
        track_runtime: false,
        ...overrides,
      },
      null,
      2,
    )}\n`,
  );
}

export const block: OpenTourBlock = {
  tourId: 'tour-4',
  goal: "The owner's surface.",
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.22, BACKLOG 1.25',
  opened: '2026-08-21',
  jobs: [
    { title: 'The commit occasion is derived', criterion: 'the hook derives it', status: 'done' },
    { title: 'The API operation set', criterion: 'every operation exists', status: 'in-progress' },
  ],
  doNotTouch: 'init and kickoff',
  stopConditions: 'a large deviation',
};

export function writeProgress(root: string, open: OpenTourBlock | null = block): void {
  writeFile(
    root,
    join(DOC_ROOT, 'PROGRESS.md'),
    [
      '# PROGRESS',
      '',
      '## Open tour',
      '',
      open === null ? 'No tour is open.' : renderOpenTourBlock(open),
      '',
      '## Pending',
      '',
      'nothing',
      '',
    ].join('\n'),
  );
}

export function marker(overrides: Partial<StateMarker> = {}): StateMarker {
  return {
    state: 'IDLE',
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: null,
    headCommit: null,
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

export function given(root: string, overrides: Partial<StateMarker> = {}): StateMarker {
  const written = marker(overrides);
  writeMarker(root, written);
  return written;
}

/** A usage line as the meter writes it, in the on-disk shape and not through it. */
export function writeUsageLines(root: string, lines: readonly Record<string, unknown>[]): void {
  writeFileSync(
    wardroomPaths(root).usageLog,
    lines.map((line) => `${JSON.stringify(line)}\n`).join(''),
  );
}

/** A gate entry file, written by hand so no reader is checked against its own writer. */
export function writeGateEntry(root: string, entry: Record<string, unknown>): void {
  writeFileSync(
    join(wardroomPaths(root).gatesDir, `${String(entry.gate_id)}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
}

/** An identifier in the grammar `listEntryIds` filters on (src/gates/id.ts). */
export const GATE_ID = 'g-20260821T093000Z-a1b2';

/** The shape of a pending gate entry, with the fields a caller wants to vary. */
export function gateEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    gate_id: GATE_ID,
    class: 'push',
    status: 'pending',
    tour_id: 'tour-4',
    job_index: 1,
    interrupted_state: 'EXECUTING',
    what: 'Push 3 commits to origin/main',
    why: 'a push leaves the machine (TD-2)',
    // The preview's `kind` is not stored: it is the gate's class, and one fact
    // gets one home (src/gates/store.ts).
    preview: {
      commits: [{ hash: 'abc1234', subject: 'feat: one' }],
      remote: 'origin',
      branch: 'main',
    },
    requested_at: '2026-08-21T09:30:00.000Z',
    decided_at: null,
    decided_by: null,
    decision_note: null,
    parked_at: null,
    ...overrides,
  };
}
