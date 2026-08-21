import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { driveExecuting } from '../../src/loop/executing.js';
import {
  type OpenTourBlock,
  readOpenTour,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';

/**
 * The `EXECUTING` drive (SDD §4.2, §3.2).
 *
 * The loop reads the job list from the open-tour block on disk, hands each job
 * to the Implementer session, and writes the marker at each boundary. It does
 * not implement anything and it does not commit anything: the session does
 * both, through the hook that holds its commits (D-57, D-65).
 */

/** Write traffic through Wardroom's one write primitive, called through. */
const writes: string[] = [];
vi.mock('../../src/fs/atomic.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/fs/atomic.js')>();
  return {
    ...real,
    atomicWriteFile: (target: string, contents: string) => {
      writes.push(target);
      real.atomicWriteFile(target, contents);
    },
  };
});

let root: string;

const DOC_ROOT = 'internal/docs';

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: DOC_ROOT,
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['true'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 3,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

const block: OpenTourBlock = {
  tourId: 'tour-9',
  goal: 'Prove the drive drives.',
  basedOn: 'CHARTER 1.3, SRS 1.10, SDD 1.11, BACKLOG 1.13',
  opened: '2026-08-21',
  jobs: [
    { title: 'First job', criterion: 'the first thing holds', status: 'pending' },
    { title: 'Second job', criterion: 'the second thing holds', status: 'pending' },
    { title: 'Third job', criterion: 'the third thing holds', status: 'pending' },
  ],
  doNotTouch: 'anything else',
  stopConditions: 'a large deviation',
};

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function writeProgress(open: OpenTourBlock): void {
  write(
    join(DOC_ROOT, 'PROGRESS.md'),
    [
      '# PROGRESS',
      '',
      '## Open tour',
      '',
      renderOpenTourBlock(open),
      '',
      '## Done',
      '',
      'none',
      '',
    ].join('\n'),
  );
}

function markerWrites(): number {
  return writes.filter((target) => target === wardroomPaths(root).stateFile).length;
}

function commitCount(): string {
  return execFileSync('git', ['rev-list', '--all', '--count'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

const START: StateMarker = {
  state: 'EXECUTING',
  tourId: 'tour-9',
  jobIndex: 0,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  headCommit: null,
  updatedAt: '2026-08-21T09:00:00.000Z',
};

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-executing-'));
  ensureRunDir(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'f@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  writeProgress(block);
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  // Resumption writes the corrected marker before anything else runs (§4.4
  // step 5), so the drive never starts against a repository with none.
  writeMarker(root, START);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * A session that records the jobs it was handed, standing in for the SDK
 * session, which needs an API key and a network this suite must not need.
 *
 * `passing` decides the acceptance criterion. The default answers false until
 * the job has been run, which is what an honest session does.
 */
function recordingSession(passing?: (index: number, ran: readonly number[]) => boolean) {
  const ran: number[] = [];
  const decide = passing ?? ((index, done) => done.includes(index));
  return {
    ran,
    session: {
      runJob: async (_job: unknown, index: number) => {
        ran.push(index);
      },
      acceptancePasses: async (_job: unknown, index: number) => decide(index, ran),
    },
  };
}

function drive(session: ReturnType<typeof recordingSession>['session'], marker = START) {
  return driveExecuting({ root, config, marker, session, now: NOW });
}

describe('the job list comes from the block on disk', () => {
  it('runs every job in order', async () => {
    const { ran, session } = recordingSession();

    await drive(session);

    expect(ran).toEqual([0, 1, 2]);
  });

  it('reads the jobs the block actually holds, not a count it was given', async () => {
    writeProgress({ ...block, jobs: block.jobs.slice(0, 2) });
    const { ran, session } = recordingSession();

    await drive(session);

    expect(ran).toEqual([0, 1]);
  });

  it('refuses to drive when no tour is open', async () => {
    write(join(DOC_ROOT, 'PROGRESS.md'), '# PROGRESS\n\n## Open tour\n\nNo tour is open.\n');

    await expect(drive(recordingSession().session)).rejects.toThrowError(/no tour is open/i);
  });

  it('refuses to drive from a state that is not EXECUTING', async () => {
    await expect(
      drive(recordingSession().session, { ...START, state: 'PLANNING' }),
    ).rejects.toThrowError(/EXECUTING/);
  });
});

describe('the marker moves once per boundary and once at the exit', () => {
  it('writes exactly one marker per job, plus one for the exit', async () => {
    const { session } = recordingSession();
    const before = markerWrites();

    await drive(session);

    expect(markerWrites() - before).toBe(block.jobs.length + 1);
  });

  it('advances job_index at each boundary, so a resume finds where it got to', async () => {
    const seen: (number | null)[] = [];
    const { ran, session } = recordingSession();
    const watching = {
      ...session,
      runJob: async (job: unknown, index: number) => {
        const read = readMarker(root);
        seen.push(read.kind === 'ok' ? read.marker.jobIndex : null);
        await session.runJob(job, index);
      },
    };

    await drive(watching);

    // Before job 0 the marker still reads the start; after each boundary it
    // reads the index the next job will be.
    expect(seen).toEqual([0, 1, 2]);
    expect(ran).toEqual([0, 1, 2]);
  });

  it('leaves the marker in VERIFYING when every job is done', async () => {
    const result = await drive(recordingSession().session);

    const read = readMarker(root);
    expect(result.marker.state).toBe('VERIFYING');
    expect(read.kind === 'ok' && read.marker.state).toBe('VERIFYING');
    expect(read.kind === 'ok' && read.marker.tourId).toBe('tour-9');
  });

  it('writes the marker to disk, not only to the value it returns', async () => {
    const result = await drive(recordingSession().session);

    const read = readMarker(root);
    expect(read.kind === 'ok' && read.marker).toEqual(result.marker);
  });
});

describe('a killed run resumes at the first job whose criterion does not pass', () => {
  it('skips the jobs whose criteria already hold', async () => {
    // Two jobs were finished before the run died. The criteria are the
    // evidence and job_index is a record, so the marker below deliberately
    // disagrees with them (SDD §4.4 step 4).
    const { ran, session } = recordingSession((index, done) => index < 2 || done.includes(index));

    await drive(session, { ...START, jobIndex: 0 });

    expect(ran).toEqual([2]);
  });

  it('believes the criterion over the recorded status', async () => {
    // The block says every job is done and the criteria say otherwise. D-65
    // names the case: a death between the status update and the commit leaves
    // a status that was never true.
    writeProgress({
      ...block,
      jobs: block.jobs.map((job) => ({ ...job, status: 'done' as const })),
    });
    const { ran, session } = recordingSession();

    await drive(session);

    expect(ran).toEqual([0, 1, 2]);
  });

  it('exits straight to VERIFYING when every criterion already passes', async () => {
    const { ran, session } = recordingSession(() => true);

    const result = await drive(session);

    expect(ran).toEqual([]);
    expect(result.marker.state).toBe('VERIFYING');
  });

  it('stops rather than looping when a job it just ran still does not pass', async () => {
    // A session reporting done on a job whose criterion still fails would
    // otherwise be handed the same job for ever. The loop stops and names the
    // job, because a loop that cannot make progress is not a retry.
    const { session } = recordingSession(() => false);

    await expect(drive(session)).rejects.toThrowError(/job 1\b/i);
  });
});

describe('the drive does not do the session s work', () => {
  it('creates no commit of its own', async () => {
    const before = commitCount();

    await drive(recordingSession().session);

    expect(commitCount()).toBe(before);
  });

  it('does not write the job statuses, because the session owns that write', async () => {
    // FR-2.1's one exception belongs to the Implementer, and D-65 puts the
    // update in the same staged set as the commit. A drive that wrote the
    // status would put it outside that set and break the rule it exists under.
    await drive(recordingSession().session);

    const read = readOpenTour(root, DOC_ROOT);
    expect(read.kind === 'open' && read.block.jobs.map((job) => job.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('leaves PROGRESS byte for byte as the session left it', async () => {
    const before = readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8');

    await drive(recordingSession().session);

    expect(readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8')).toBe(before);
  });
});
