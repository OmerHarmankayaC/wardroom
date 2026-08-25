import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { decide as decideGate, enqueue } from '../../src/gates/queue.js';
import { runCycle } from '../../src/loop/run.js';
import { type OpenTourBlock, renderOpenTourBlock } from '../../src/progress/open-tour.js';
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
      open === null ? 'None.' : renderOpenTourBlock(open),
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
  return {
    planned,
    ran,
    settled,
    logs,
    sessions: {
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
    },
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
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const doubles = sessions();

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.ran).toEqual([0, 1, 2]);
    // The PM is not consulted: the state names one driver, not a sequence to
    // start from the top.
    expect(doubles.planned).toEqual([]);
  });

  it('drives VERIFYING from a marker that reads VERIFYING, without re-running the jobs', async () => {
    writeMarker(root, marker({ state: 'VERIFYING', tourId: TOUR, jobIndex: 3 }));
    const doubles = sessions();

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.ran).toEqual([]);
    expect(doubles.logs).toEqual([TOUR]);
  });

  it('drives FAILED from a marker that reads FAILED', async () => {
    writeMarker(root, marker({ state: 'FAILED', tourId: TOUR, jobIndex: 3, attemptCount: 1 }));
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
    writeMarker(root, marker({ state: 'IDLE' }));
    const doubles = sessions();

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
    writeMarker(root, marker({ state: 'IDLE' }));
    const doubles = sessions();

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.ran).toEqual([0, 1, 2]);
  });

  it('does not open a second tour after reaching IDLE', async () => {
    // The block is cleared at closure, so a loop that carried on would find no
    // tour and plan one. Nothing may call the PM after IDLE is reached.
    writeMarker(root, marker({ state: 'IDLE' }));
    const doubles = sessions({ planWrites: true });

    await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(doubles.planned).toEqual([]);
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
    writeMarker(
      root,
      marker({
        state: 'GATED',
        tourId: TOUR,
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        gateId: entry.gateId,
      }),
    );
    const doubles = sessions();

    const outcome = await runCycle({ root, sessions: doubles.sessions, now: NOW });

    expect(outcome.kind).toBe('gated');
    expect(doubles.ran).toEqual([]);
    expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { state: 'GATED' } });
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
    writeMarker(
      root,
      marker({
        state: 'PARKED',
        tourId: TOUR,
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        gateId: entry.gateId,
      }),
    );

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
    writeMarker(
      root,
      marker({
        state: 'GATED',
        tourId: TOUR,
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        gateId: entry.gateId,
      }),
    );
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
      writeMarker(root, marker({ state: 'CLOSING', tourId: TOUR, jobIndex: 3, disposition }));
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
    writeMarker(
      root,
      marker({ state: 'CLOSING', tourId: TOUR, jobIndex: 3, disposition: 'carried' }),
    );

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
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const doubles = sessions();
    const wip: string[] = [];

    const outcome = await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        // A session that runs the job and leaves its criterion failing is the
        // stop condition §4.2 names: the loop stops rather than handing the
        // same job over again.
        implementer: {
          runJob: async () => undefined,
          acceptancePasses: async () => false,
        },
      },
      commitWip: async (stop: { message: string }) => {
        wip.push(stop.message);
      },
      now: NOW,
    });

    expect(outcome.kind).toBe('stopped');
    expect(wip).toHaveLength(1);
    expect(wip[0]).toMatch(/^WIP:/);
  });

  it('states why it stopped rather than stopping silently', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        implementer: {
          runJob: async () => undefined,
          acceptancePasses: async () => false,
        },
      },
      commitWip: async () => undefined,
      now: NOW,
    });

    expect(outcome.reason).toMatch(/acceptance criterion/);
  });

  it('asks for no WIP commit where no committer was supplied, and says so', async () => {
    // The loop never runs git itself: the commit is the caller's, gated by
    // §4.5. An absent committer must leave a stop that says nothing was asked
    // for, not one that reads as though a commit happened.
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        implementer: {
          runJob: async () => undefined,
          acceptancePasses: async () => false,
        },
      },
      now: NOW,
    });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.wipRequested).toBe(false);
  });
});

describe('a cooperative stop takes effect at a job boundary', () => {
  it('stops after the job in flight and never mid-job', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
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
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
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
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
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
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 2 }));
    const doubles = sessions();

    const outcome = await runCycle({
      root,
      sessions: {
        ...doubles.sessions,
        implementer: {
          runJob: async (_job: unknown, index: number) => {
            doubles.ran.push(index);
          },
          // Only the last job is outstanding.
          acceptancePasses: async (_job: unknown, index: number) =>
            index < 2 || doubles.ran.includes(index),
        },
      },
      stopRequested: () => true,
      now: NOW,
    });

    expect(outcome.kind).not.toBe('detached');
  });
});

describe('every transition is one marker write through the machine', () => {
  it('writes the marker once per transition and never beside the machine', async () => {
    writeMarker(root, marker({ state: 'IDLE' }));
    writes.length = 0;
    advances.length = 0;
    const doubles = sessions();

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
    writeMarker(
      root,
      marker({
        state: 'GATED',
        tourId: TOUR,
        jobIndex: 1,
        interruptedState: 'EXECUTING',
        gateId: entry.gateId,
      }),
    );
    writes.length = 0;
    advances.length = 0;

    await runCycle({ root, sessions: sessions().sessions, now: NOW });

    expect(advances).toEqual([]);
    // Resumption's own write and nothing else: the loop found a state it may
    // not move and moved nothing.
    expect(markerWrites()).toBe(1);
  });
});
