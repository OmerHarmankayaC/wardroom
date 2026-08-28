import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { decide as decideGate, enqueue } from '../../src/gates/queue.js';
import { readEntry } from '../../src/gates/store.js';
import { type DriverSessionFactory, fixedSessions } from '../../src/loop/driver-sessions.js';
import { runCycle } from '../../src/loop/run.js';
import type { ScopedSession } from '../../src/loop/wiring.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { advance } from '../../src/state/machine.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';
import { writeReport } from '../../src/state/report.js';

/**
 * The run cycle (SDD §5.1, §3.2, D-83).
 *
 * One invocation drives one cycle: from a marker on disk it calls the driver
 * the state names, runs `IDLE` to `IDLE`, and returns rather than planning the
 * next tour. The other exits are the ones §3.2 already defines.
 *
 * The drivers are exercised for real here; only the sessions are doubles. A
 * loop tested against doubled drivers would prove the dispatch table and
 * nothing about whether the states actually connect, which is the one thing
 * this job adds (D-85: the seam is the SDK, not the drivers).
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

/** Every transition anyone made, in order, called through (D-47). */
const advances: string[] = [];
vi.mock('../../src/state/machine.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/state/machine.js')>();
  return {
    ...real,
    advance: (
      root: string,
      current: Parameters<typeof real.advance>[1],
      event: Parameters<typeof real.advance>[2],
      rules: Parameters<typeof real.advance>[3],
      now?: Date,
    ) => {
      advances.push(event.type);
      return real.advance(root, current, event, rules, now);
    },
  };
});

let root: string;

const DOC_ROOT = 'internal/docs';
const TOUR = 'tour-9';

const block: OpenTourBlock = {
  tourId: TOUR,
  goal: 'Prove the cycle cycles.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.16, BACKLOG 1.19',
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

function writeProgress(open: OpenTourBlock | null): void {
  write(
    join(DOC_ROOT, 'PROGRESS.md'),
    [
      '# PROGRESS',
      '',
      '## Open tour',
      '',
      // The statement §3.5 fixes, not a paraphrase: "None." parses as a
      // malformed block, which is a different answer from no tour at all.
      open === null ? NO_OPEN_TOUR_STATEMENT : renderOpenTourBlock(open),
      '',
      '## Done',
      '',
      'none',
      '',
      // A carried tour writes its unfinished jobs here (§4.6 step 5, D-66),
      // so the fixture carries the section a real PROGRESS does.
      '## Pending',
      '',
      'nothing',
      '',
    ].join('\n'),
  );
}

function writeConfig(): void {
  write(
    '.wardroom/config.json',
    `${JSON.stringify(
      {
        name: 'example',
        level: 'full',
        doc_root: DOC_ROOT,
        default_branch: 'main',
        stack: { language: 'TypeScript', runtime: 'node>=18', package_manager: 'npm' },
        // `true` is a command that passes, so green is reachable without
        // running a suite inside a suite.
        verify: ['true'],
        auth_mode: 'api_key',
        gate_wait: '24h',
        attempt_budget: 3,
        usage_budget: { usd: 10 },
        track_runtime: false,
      },
      null,
      2,
    )}\n`,
  );
}

function markerWrites(): number {
  return writes.filter((target) => target === wardroomPaths(root).stateFile).length;
}

function commit(message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', message], { cwd: root });
}

function head(): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Writes a marker and the block that agrees with it (SDD §4.4, D-96, D-100).
 *
 * Resumption compares two records and lets neither correct the other, so a
 * fixture that wrote a marker at job 3 against a block whose rows were all
 * pending would be a fixture the cross-check is right to stop on. The rows the
 * marker says are behind it are marked done here, which is what a tour that
 * reached that boundary would have left.
 */
function given(overrides: Partial<StateMarker>): void {
  const at = overrides.jobIndex ?? 0;
  // A tour that is over left the block cleared (§4.6 step 6), and a marker at
  // IDLE against an open block is a conflict, not a window (D-104).
  if (overrides.tourId == null && (overrides.state ?? 'IDLE') === 'IDLE') {
    writeProgress(null);
  } else if (overrides.tourId != null) {
    writeProgress({
      ...block,
      jobs: block.jobs.map((job, index) => ({
        ...job,
        status: index < at ? 'done' : job.status,
      })),
    });
  }
  // Committed, because the block is a tracked file here and a tour never
  // opens over uncommitted work without the owner saying so (FR-1.6): an
  // uncommitted fixture would raise the dirty-tree gate instead.
  if (
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== ''
  ) {
    commit('the state the tour is resumed from');
  }
  writeMarker(root, marker(overrides));
}

function marker(overrides: Partial<StateMarker>): StateMarker {
  return {
    state: 'IDLE',
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: null,
    headCommit: head(),
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

/** A session that runs a job and leaves its acceptance criterion failing. */
function stuckImplementer(): ScopedSession<{
  runJob: () => Promise<void>;
  acceptancePasses: () => Promise<boolean>;
}> {
  return {
    session: {
      runJob: async () => undefined,
      acceptancePasses: async () => false,
    },
    close: async () => ({ text: null, errors: [], failed: false }),
  };
}

/**
 * Sessions that record what they were asked to do. The acceptance criterion
 * answers false until the job has been run, which is what an honest session
 * does.
 */
function sessions(options: { readonly planWrites?: boolean } = {}) {
  const planned: number[] = [];
  const ran: number[] = [];
  const settled: string[] = [];
  const logs: string[] = [];
  /** Every session this cycle opened, in order, by the state it was opened for. */
  const opened: string[] = [];
  const closed: string[] = [];

  const fixed = fixedSessions({
    pm: {
      plan: async () => {
        planned.push(planned.length);
        if (options.planWrites === true) writeProgress(block);
      },
    },
    implementer: {
      runJob: async (_job: unknown, index: number) => {
        ran.push(index);
      },
      acceptancePasses: async (_job: unknown, index: number) => ran.includes(index),
    },
    closing: {
      settleDebt: async (debt: { document: string }) => {
        settled.push(debt.document);
      },
      writeTourLog: async (log: { tourId: string }) => {
        logs.push(log.tourId);
      },
    },
  });

  /**
   * Counts the openings, which is what D-99 is about: one session per entry
   * into one state, and a re-entry opens another rather than reusing the first.
   */
  function counting<T>(state: string, open: () => ScopedSession<T>): ScopedSession<T> {
    opened.push(state);
    const scoped = open();
    return {
      session: scoped.session,
      close: async () => {
        closed.push(state);
        return await scoped.close();
      },
    };
  }

  return {
    planned,
    ran,
    settled,
    logs,
    opened,
    closed,
    sessions: {
      planning: () => counting('PLANNING', () => fixed.planning()),
      executing: (tourId: string) => counting('EXECUTING', () => fixed.executing(tourId)),
      closing: (tourId: string) => counting('CLOSING', () => fixed.closing(tourId)),
    } satisfies DriverSessionFactory,
  };
}

beforeEach(() => {
  writes.length = 0;
  advances.length = 0;
  root = mkdtempSync(join(tmpdir(), 'wardroom-run-'));
  ensureRunDir(root);
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'f@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  writeConfig();
  writeProgress(block);
  writeReport(root, {
    tourId: TOUR,
    commits: [],
    pushed: false,
    jobs: [{ title: 'First job', verdict: 'done' }],
    deviations: [],
    debts: [],
    auditFindings: [],
    notes: '',
  });
  commit('fixture');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the loop calls the driver the marker names', () => {
  it('drives EXECUTING from a marker that reads EXECUTING', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.ran).toEqual([0, 1, 2]);
    // The PM is not consulted: the state names one driver, not a sequence to
    // start from the top.
    expect(doubles.planned).toEqual([]);
  });

  it('drives VERIFYING from a marker that reads VERIFYING, without re-running the jobs', async () => {
    given({ state: 'VERIFYING', tourId: TOUR, jobIndex: 3 });
    const doubles = sessions();

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.ran).toEqual([]);
    expect(doubles.logs).toEqual([TOUR]);
  });

  it('drives FAILED from a marker that reads FAILED', async () => {
    given({ state: 'FAILED', tourId: TOUR, jobIndex: 3, attemptCount: 1 });
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    // No failure record survives, so the tour is verified again rather than
    // guessed at (§4.4 step 4), which is the FAILED driver's answer and not
    // the loop's.
    expect(outcome.visited).toContain('VERIFYING');
  });
});

describe('one invocation is one cycle', () => {
  it('runs IDLE to IDLE and returns rather than planning again', async () => {
    // From a closed boundary: the block is cleared, as closure left it, and
    // planning writes the one this cycle runs (§4.1 step 7).
    given({ state: 'IDLE' });
    const doubles = sessions({ planWrites: true });

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).toBe('idle');
    expect(outcome.visited).toEqual([
      'IDLE',
      'PLANNING',
      'EXECUTING',
      'VERIFYING',
      'CLOSING',
      'IDLE',
    ]);
    expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { state: 'IDLE' } });
  });

  it('hands each job to the session exactly once over that cycle', async () => {
    given({ state: 'IDLE' });
    const doubles = sessions({ planWrites: true });

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.ran).toEqual([0, 1, 2]);
  });

  it('does not open a second tour after reaching IDLE', async () => {
    // The block is cleared at closure, so a loop that carried on would find no
    // tour and plan one. Nothing may call the PM after IDLE is reached.
    given({ state: 'IDLE' });
    const doubles = sessions({ planWrites: true });

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    // Once, for this cycle, and not again after IDLE is reached.
    expect(doubles.planned).toEqual([0]);
  });
});

describe('the exits §3.2 defines', () => {
  it('blocks on GATED and calls no driver', async () => {
    const entry = enqueue(root, {
      gateClass: 'scope-change',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'a scope decision',
      why: 'the owner decides scope',
      preview: {
        kind: 'scope-change',
        sections: [{ document: 'SRS', section: '§4', diff: '+ a proposed line' }],
      },
    });
    given({
      state: 'GATED',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: entry.gateId,
    });
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).toBe('gated');
    expect(doubles.ran).toEqual([]);
    expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { state: 'GATED' } });
  });

  it('parks a gate whose wait ran out while nothing was running (D-107)', async () => {
    // The case the state exists for: the gate was raised, the run exited, and
    // the waiting period ran out overnight with no process alive to notice.
    // Without a reading that computes it, this run would report the
    // orchestrator blocked on a wait that ended hours ago.
    const entry = enqueue(
      root,
      {
        gateClass: 'push',
        tourId: TOUR,
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        what: 'Push 2 commits to origin/main',
        why: 'a push leaves the machine (TD-2)',
        preview: {
          kind: 'push',
          commits: [{ hash: 'abc1234', subject: 'feat: one' }],
          remote: 'origin',
          branch: 'main',
        },
      },
      { now: new Date('2026-08-21T10:00:00.000Z') },
    );
    given({
      state: 'GATED',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: entry.gateId,
    });
    const doubles = sessions();

    // `gate_wait` is 24h in this fixture, so a day and an hour later.
    const outcome = await runCycle({
      root,
      sessions: doubles.sessions,
      now: () => new Date('2026-08-22T11:00:00.000Z'),
    });

    expect(outcome.kind).toBe('parked');
    expect(doubles.ran).toEqual([]);
    expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { state: 'PARKED' } });
    // The gate is still pending and still the owner's to answer: parking
    // releases the orchestrator, it never decides (D-27).
    expect(readEntry(root, entry.gateId)?.status).toBe('pending');
    expect(readEntry(root, entry.gateId)?.parkedAt).not.toBeNull();
  });

  it('leaves a gate inside its waiting period gated', async () => {
    // The discriminating case for the one above: a run that parked everything
    // it found would pass that one and be wrong here.
    const entry = enqueue(
      root,
      {
        gateClass: 'push',
        tourId: TOUR,
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        what: 'Push 2 commits to origin/main',
        why: 'a push leaves the machine (TD-2)',
        preview: {
          kind: 'push',
          commits: [{ hash: 'abc1234', subject: 'feat: one' }],
          remote: 'origin',
          branch: 'main',
        },
      },
      { now: new Date('2026-08-21T10:00:00.000Z') },
    );
    given({
      state: 'GATED',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: entry.gateId,
    });

    const outcome = await runCycle({
      root,
      sessions: sessions().sessions,
      now: () => new Date('2026-08-22T09:00:00.000Z'),
    });

    expect(outcome.kind).toBe('gated');
    expect(readEntry(root, entry.gateId)?.parkedAt).toBeNull();
  });

  it('returns from PARKED with a non-error status', async () => {
    const entry = enqueue(root, {
      gateClass: 'scope-change',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'a scope decision',
      why: 'the owner decides scope',
      preview: {
        kind: 'scope-change',
        sections: [{ document: 'SRS', section: '§4', diff: '+ a proposed line' }],
      },
    });
    given({
      state: 'PARKED',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: entry.gateId,
    });

    const outcome = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(outcome.kind).toBe('parked');
    expect(outcome.error).toBeNull();
  });
});

describe('a decided gate is applied from the entry', () => {
  it('resumes the interrupted state when the owner approved while the process was down', async () => {
    const entry = enqueue(root, {
      gateClass: 'scope-change',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'a scope decision',
      why: 'the owner decides scope',
      preview: {
        kind: 'scope-change',
        sections: [{ document: 'SRS', section: '§4', diff: '+ a proposed line' }],
      },
    });
    decideGate(root, entry.gateId, 'approved', 'owner');
    given({
      state: 'GATED',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: entry.gateId,
    });
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    // Back into EXECUTING and on through the tour, rather than blocking on a
    // gate the owner has already answered.
    expect(outcome.kind).toBe('idle');
    expect(outcome.visited).toContain('EXECUTING');
  });
});

describe('a cycle that resumes into CLOSING reads the disposition it died under', () => {
  /**
   * D-92. Before the marker carried the disposition this was the one thing a
   * resumed closure could not know: `gate_id` is cleared the moment a decision
   * is applied (D-62), so an abandoned tour had no key left to find its entry
   * with and would have closed as `closed`, with the tour log, which is the
   * permanent record, saying so.
   */
  for (const disposition of ['abandoned', 'carried'] as const) {
    it(`closes a ${disposition} tour as ${disposition}, with no gate entry to read`, async () => {
      given({ state: 'CLOSING', tourId: TOUR, jobIndex: 3, disposition });
      // Nothing is enqueued: the point is that the answer survives without an
      // entry, which is what the marker field is for.
      expect(readdirSync(wardroomPaths(root).gatesDir)).toEqual([]);

      const doubles = sessions();
      const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

      expect(outcome.kind).toBe('idle');
      expect(outcome.disposition).toBe(disposition);
      expect(outcome.reason).toBeNull();
    });
  }

  it('leaves no disposition on the marker once the tour reaches IDLE', async () => {
    given({ state: 'CLOSING', tourId: TOUR, jobIndex: 3, disposition: 'carried' });

    const outcome = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(outcome.marker?.state).toBe('IDLE');
    expect(outcome.marker?.disposition).toBeNull();
    // Read back from disk, because a verdict left standing there is one the
    // next entry into CLOSING would find already answered.
    expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { disposition: null } });
  });
});

describe('a stop condition ends with a WIP commit', () => {
  it('commits once when a job cannot be advanced', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();
    const wip: string[] = [];

    const outcome = await runCycle({
      root,
      // A session that runs the job and leaves its criterion failing is the
      // stop condition §4.2 names: the loop stops rather than handing the same
      // job over again.
      sessions: { ...doubles.sessions, executing: () => stuckImplementer() },
      commitWip: async (stop: { message: string }) => {
        wip.push(stop.message);
        return { committed: true, hash: null, blocks: [] };
      },
      now: NOW,
    });

    expect(outcome.kind).toBe('stopped');
    expect(wip).toHaveLength(1);
    expect(wip[0]).toMatch(/^WIP:/);
  });

  it('states why it stopped rather than stopping silently', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: { ...doubles.sessions, executing: () => stuckImplementer() },
      commitWip: async () => ({ committed: true, hash: null, blocks: [] }),
      now: NOW,
    });

    expect(outcome.reason).toMatch(/acceptance criterion/);
  });

  it('asks for no WIP commit where no committer was supplied, and says so', async () => {
    // The loop never runs git itself: the commit is the caller's, gated by
    // §4.5. An absent committer must leave a stop that says nothing was asked
    // for, not one that reads as though a commit happened.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: { ...doubles.sessions, executing: () => stuckImplementer() },
      now: NOW,
    });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.wipRequested).toBe(false);
  });
});

describe('a cooperative stop takes effect at a job boundary', () => {
  it('stops after the job in flight and never mid-job', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();
    let boundaries = 0;

    const outcome = await runCycle({
      root,
      sessions: doubles.sessions,
      stopRequested: () => {
        boundaries += 1;
        return boundaries >= 1;
      },
      now: NOW,
    });

    expect(outcome.kind).toBe('detached');
    // The first job ran to completion; the second was never handed over.
    expect(doubles.ran).toEqual([0]);
  });

  it('leaves the marker at the boundary, for the ordinary resumption path', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();

    await runCycle({
      root,
      sessions: doubles.sessions,
      stopRequested: () => true,
      now: NOW,
    });

    // EXECUTING and not VERIFYING: a detached tour has jobs left, and a marker
    // moved on would tell the next run the list was finished.
    expect(readMarker(root)).toMatchObject({
      kind: 'ok',
      marker: { state: 'EXECUTING', jobIndex: 1 },
    });
  });

  it('is never asked before the first boundary', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();
    const askedAfter: number[] = [];

    await runCycle({
      root,
      sessions: doubles.sessions,
      stopRequested: () => {
        askedAfter.push(doubles.ran.length);
        return false;
      },
      now: NOW,
    });

    // Asked once per boundary, and the first ask comes after a job has run.
    expect(askedAfter).toEqual([1, 2, 3]);
  });

  it('does not stop a tour whose job list finished on the same boundary', async () => {
    // The last boundary stops nothing: the list is done, and calling that a
    // detach would leave a finished tour looking unfinished.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 2 });
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        executing: () => ({
          session: {
            runJob: async (_job: unknown, index: number) => {
              doubles.ran.push(index);
            },
            // Only the last job is outstanding.
            acceptancePasses: async (_job: unknown, index: number) =>
              index < 2 || doubles.ran.includes(index),
          },
          close: async () => ({ text: null, errors: [], failed: false }),
        }),
      },
      stopRequested: () => true,
      now: NOW,
    });

    expect(outcome.kind).not.toBe('detached');
  });
});

describe('the stop request is a file the loop reads (D-106)', () => {
  /** What `detach` writes, written here without going through it. */
  function writeRequest(): void {
    ensureRunDir(root);
    writeFileSync(wardroomPaths(root).stopRequestFile, '');
  }

  function requestStands(): boolean {
    return readdirSync(wardroomPaths(root).runDir).includes('stop-requested');
  }

  it('deletes a stale request at startup and finishes the tour', async () => {
    // The failure the file shape invites. A detach nobody honoured, left by a
    // run that is already gone, would otherwise stop the next tour at its
    // first boundary for a reason nobody could see. The request below is aimed
    // at a run that no longer exists, and this run must not answer it.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    writeRequest();
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).not.toBe('detached');
    // All three jobs, not one: the tour ran its list out.
    expect(doubles.ran).toEqual([0, 1, 2]);
    expect(requestStands()).toBe(false);
  });

  it('honours a request that arrives while the run is up', async () => {
    // The same file, written during the run rather than before it, which is
    // what a detach against a live loop looks like.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();
    const ran: number[] = [];

    const outcome = await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        executing: () => ({
          session: {
            runJob: async (_job: unknown, index: number) => {
              ran.push(index);
              if (index === 0) writeRequest();
            },
            acceptancePasses: async (_job: unknown, index: number) => ran.includes(index),
          },
          close: async () => ({ text: null, errors: [], failed: false }),
        }),
      },
      now: NOW,
    });

    expect(outcome.kind).toBe('detached');
    expect(ran).toEqual([0]);
  });

  it('honours it by deleting it, so the next run is not stopped by the same ask', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();
    const ran: number[] = [];

    await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        executing: () => ({
          session: {
            runJob: async (_job: unknown, index: number) => {
              ran.push(index);
              if (index === 0) writeRequest();
            },
            acceptancePasses: async (_job: unknown, index: number) => ran.includes(index),
          },
          close: async () => ({ text: null, errors: [], failed: false }),
        }),
      },
      now: NOW,
    });

    expect(requestStands()).toBe(false);
  });

  it('runs on where no request was ever written', async () => {
    // The discriminating case for the two above: without it, a loop that never
    // read the file at all would pass both.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).not.toBe('detached');
    expect(doubles.ran).toEqual([0, 1, 2]);
  });

  it('lets an injected answer stand in for the file, and clears the file anyway', async () => {
    // The drives are exercised without a filesystem request elsewhere in this
    // file, so the seam stays. What must not survive is the request itself: a
    // run beginning invalidates any earlier one whoever is being asked.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    writeRequest();
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: doubles.sessions,
      stopRequested: () => false,
      now: NOW,
    });

    expect(outcome.kind).not.toBe('detached');
    expect(requestStands()).toBe(false);
  });
});

describe('every transition is one marker write through the machine', () => {
  it('writes the marker once per transition and never beside the machine', async () => {
    given({ state: 'IDLE' });
    writes.length = 0;
    advances.length = 0;
    const doubles = sessions({ planWrites: true });

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    // The transitions of one full cycle: open, plan-complete, three job
    // boundaries, jobs-done, green, close.
    expect(advances).toEqual([
      'open',
      'plan-complete',
      'job-boundary',
      'job-boundary',
      'job-boundary',
      'jobs-done',
      'green',
      'close',
    ]);
    // Resumption writes the corrected marker before any transition runs (§4.4
    // step 5); every write after it is one `advance`. Counted this way rather
    // than from a tally the loop keeps, because a tally the loop maintains
    // would be the loop's account of itself, and D-47 is about what actually
    // reached the file.
    expect(markerWrites()).toBe(advances.length + 1);
  });

  it('writes no marker for a transition the machine refuses', async () => {
    // GATED accepts a decision and a park and nothing else; the loop must not
    // reach around the machine to move it.
    const entry = enqueue(root, {
      gateClass: 'scope-change',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'a scope decision',
      why: 'the owner decides scope',
      preview: {
        kind: 'scope-change',
        sections: [{ document: 'SRS', section: '§4', diff: '+ a proposed line' }],
      },
    });
    given({
      state: 'GATED',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: entry.gateId,
    });
    writes.length = 0;
    advances.length = 0;

    await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(advances).toEqual([]);
    // Resumption's own write and nothing else: the loop found a state it may
    // not move and moved nothing.
    expect(markerWrites()).toBe(1);
  });
});

/**
 * Where resumption stops, the run stops with it and says what each record
 * said (SDD §4.4, D-96, D-100).
 *
 * A message that said only "they disagree" would leave the owner opening the
 * two files by hand, which is the work the stop exists to save them.
 */
describe('a run that cannot establish a state reports both readings', () => {
  it('names the pair, the marker reading and the block reading, and writes nothing', async () => {
    // The block says tour-9 and the marker says another tour: two records,
    // neither of them evidence, and no rule for choosing between them.
    writeProgress(block);
    writeMarker(root, marker({ state: 'EXECUTING', tourId: 'tour-99', jobIndex: 0 }));
    const before = readMarker(root);
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.reason).toContain('tour_id');
    expect(outcome.reason).toContain('tour-99');
    expect(outcome.reason).toContain(TOUR);
    // No driver ran and the marker is untouched.
    expect(doubles.opened).toEqual([]);
    expect(readMarker(root)).toEqual(before);
  });

  it('names head_commit where the marker points at work this repository does not have', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0, headCommit: 'f'.repeat(40) });

    const outcome = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.reason).toContain('head_commit');
  });
});

/**
 * The disposition survives the states between the decision and the closure
 * (SDD §3.3, D-101).
 *
 * The rule this replaces wrote it on entry into `CLOSING`, one state after
 * each of the two decisions that are not made there, which left two windows: a
 * carried tour that died in `VERIFYING` reached closure as `closed`, and a
 * gate raised from `CLOSING` dropped a verdict already decided.
 */
describe('a disposition decided before CLOSING reaches CLOSING', () => {
  it('closes a tour carried where the run died in VERIFYING after the ceiling fired', async () => {
    // The marker as the boundary that decided it left it, and the death right
    // after: nothing else on disk says the ceiling fired.
    given({ state: 'VERIFYING', tourId: TOUR, jobIndex: 3, disposition: 'carried' });
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).toBe('idle');
    expect(outcome.disposition).toBe('carried');
  });

  it('records closed where nothing decided otherwise, without overwriting one that did', async () => {
    given({ state: 'VERIFYING', tourId: TOUR, jobIndex: 3 });

    const outcome = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(outcome.disposition).toBe('closed');
  });

  it('carries the disposition through a scope-change gate raised from CLOSING', async () => {
    // A debt the PM cannot settle without a scope decision raises the gate
    // from CLOSING (§4.6 step 3, D-75). The marker moves to GATED and back,
    // and the verdict has to be the same on both sides of it.
    writeReport(root, {
      tourId: TOUR,
      commits: [],
      pushed: false,
      jobs: [],
      deviations: [],
      debts: [
        {
          document: 'SRS.md',
          section: '4',
          problem: 'the requirement and the design disagree',
          settleable: false,
        },
      ],
      auditFindings: [],
      notes: 'none',
    });
    given({ state: 'CLOSING', tourId: TOUR, jobIndex: 3, disposition: 'carried' });

    const outcome = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(outcome.kind).toBe('gated');
    const gated = readMarker(root);
    expect(gated.kind === 'ok' && gated.marker.state).toBe('GATED');
    expect(gated.kind === 'ok' && gated.marker.disposition).toBe('carried');

    // The owner declines, which settles the debt (D-79), and the tour closes
    // under the disposition it left CLOSING with.
    decideGate(root, outcome.gateId ?? '', 'rejected', 'owner');
    const closed = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(closed.kind).toBe('idle');
    expect(closed.disposition).toBe('carried');
  });
});

/**
 * The three kill points that used to deadlock (SDD §4.4, D-104).
 *
 * The first rule written here compared the two records for identity, and a
 * running kill test showed what that meant: three of five kill points stopped
 * the run permanently, writing nothing, with the same message on every retry.
 * The reason is structural. §4.2 writes the block and its commit first (D-65)
 * and the marker after (D-47), so every window §4.4 tabulates is a moment when
 * the two records legitimately differ.
 *
 * Each case below is the repository as that death left it: the block written
 * and committed, the marker not yet advanced.
 */
describe('a run resumes from the lag the write order creates', () => {
  /** Marks the first `done` rows, as a boundary leaves the block. */
  function blockAt(done: number): OpenTourBlock {
    return {
      ...block,
      jobs: block.jobs.map((job, index) => ({
        ...job,
        status: index < done ? ('done' as const) : job.status,
      })),
    };
  }

  /** The block committed and the marker left where the death found it. */
  function died(rowsDone: number, at: Partial<StateMarker>): void {
    writeProgress(blockAt(rowsDone));
    commit(`job ${rowsDone}`);
    writeMarker(root, marker(at));
  }

  for (const rowsDone of [1, 2]) {
    it(`resumes where job ${rowsDone} was committed and the marker not advanced`, async () => {
      died(rowsDone, { state: 'EXECUTING', tourId: TOUR, jobIndex: rowsDone - 1 });
      const doubles = sessions();

      const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

      expect(outcome.kind).toBe('idle');
      expect(outcome.disposition).toBe('closed');
    });
  }

  it('resumes where the block was cleared and the closure commit not made', async () => {
    // §4.6 step 6 clears the block before the commit, so a death between them
    // leaves a marker naming a tour and a section saying none is open.
    writeProgress(null);
    commit('the cleared block');
    writeMarker(
      root,
      marker({ state: 'CLOSING', tourId: TOUR, jobIndex: 3, disposition: 'closed' }),
    );

    const outcome = await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(outcome.kind).toBe('idle');
  });

  it('still stops on a reading no sequence produces, and writes nothing', async () => {
    // Two rows ahead: no window skips a job, because one boundary moves one
    // row and writes the marker after it.
    died(2, { state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const before = readMarker(root);
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.reason).toMatch(/more than one row ahead/);
    expect(doubles.opened).toEqual([]);
    expect(readMarker(root)).toEqual(before);
  });
});
