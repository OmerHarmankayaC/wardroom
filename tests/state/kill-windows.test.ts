import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { readDocBaseline, recordClosureBaseline } from '../../src/documents/baseline.js';
import { readAuditLines } from '../../src/gates/audit.js';
import { authorizationFor, decide, enqueue } from '../../src/gates/queue.js';
import { createDriverSessions, fixedSessions } from '../../src/loop/driver-sessions.js';
import { driveExecuting } from '../../src/loop/executing.js';
import { FAIL, PASS } from '../../src/loop/prompts.js';
import { type RunOutcome, runCycle } from '../../src/loop/run.js';
import { createSessionWiring, markerOnDisk } from '../../src/loop/wiring.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  readOpenTour,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';
import { type ClosingReport, renderReport, writeReport } from '../../src/state/report.js';
import { resume } from '../../src/state/resume.js';
import { resultMessage } from '../support/sdk-messages.js';

/**
 * K-3, the guarantee: a killed run resumes where §4.4 says it does.
 *
 * The deaths that matter are inside states, in the gap between two writes that
 * were meant to be one act, and §4.4 carries a table of them (D-97). This file
 * enumerates that table rather than a list of its own: the rows are
 * transcribed by hand into `windows.fixture.json`, every case here names the
 * row it answers, and a case naming a row the fixture does not carry throws.
 *
 * The limit of that promise is worth stating rather than implying. The design
 * document is untracked in this repository (D-8), so nothing here can read it,
 * and nothing here can notice a row added to the document and not to the
 * fixture. What it does catch is a row dropped from the list once written
 * down, a case invented beside the list, and a window whose real behaviour has
 * stopped matching the answer written next to it.
 *
 * Each window is built as the death leaves it: the first write made, the
 * second not. That is not a simulation of the kill, it is its result, and the
 * result is the whole of what resumption meets. The transition sweep at the
 * end is the other half, where the run really is stopped part way through.
 */

/** Transitions to allow before the simulated death, or Infinity for none. */
let dieAfterTransitions = Number.POSITIVE_INFINITY;
let transitionsSeen = 0;

class SimulatedDeath extends Error {}

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
      if (transitionsSeen >= dieAfterTransitions) {
        // Before the write, so the marker stays where the last completed
        // transition left it, which is what a killed process leaves behind.
        throw new SimulatedDeath(`killed before transition ${transitionsSeen + 1}`);
      }
      transitionsSeen += 1;
      return real.advance(root, current, event, rules, now);
    },
  };
});

interface Window {
  readonly id: string;
  readonly window: string;
  readonly cites: string;
  readonly answer: string;
}

const table = JSON.parse(
  readFileSync(join(import.meta.dirname, 'windows.fixture.json'), 'utf8'),
) as { source: string; windows: readonly Window[] };

const DOC_ROOT = 'internal/docs';
const TOUR = 'tour-9';

let root: string;

const block: OpenTourBlock = {
  tourId: TOUR,
  goal: 'Prove a killed tour resumes.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.19, BACKLOG 1.22',
  opened: '2026-08-21',
  jobs: [
    { title: 'First job', criterion: 'the first thing holds', status: 'pending' },
    { title: 'Second job', criterion: 'the second thing holds', status: 'pending' },
  ],
  doNotTouch: 'the CLI',
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
      open === null ? NO_OPEN_TOUR_STATEMENT : renderOpenTourBlock(open),
      '',
      '## Pending',
      '',
      'nothing',
      '',
    ].join('\n'),
  );
}

/** The block with its first `done` rows marked, which is what a boundary leaves. */
function blockAt(done: number): OpenTourBlock {
  return {
    ...block,
    jobs: block.jobs.map((job, index) => ({
      ...job,
      status: index < done ? ('done' as const) : job.status,
    })),
  };
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function head(): string {
  return git('rev-parse', 'HEAD').trim();
}

function commitAll(message: string): string {
  git('add', '-A');
  git('commit', '-qm', message);
  return head();
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
 * Sessions that do what a real one would leave behind: the status update, the
 * commit, and the report at the end.
 *
 * They stand in for the SDK, which is the seam D-85 puts the boundary at. What
 * matters here is that they leave the repository in the shape a resumed run
 * has to read, so a resumed run and an uninterrupted one can be compared.
 */
function sessions() {
  const ran: number[] = [];
  const logs: string[] = [];
  return {
    ran,
    logs,
    factory: fixedSessions({
      pm: {
        plan: async () => {
          writeProgress(block);
        },
      },
      implementer: {
        runJob: async (_job: unknown, index: number) => {
          ran.push(index);
          writeProgress(blockAt(index + 1));
          write(`src/job-${index}.ts`, `export const job${index} = true;\n`);
          commitAll(`job ${index + 1}`);
        },
        acceptancePasses: async (_job: unknown, index: number) => ran.includes(index),
      },
      closing: {
        settleDebt: async () => undefined,
        writeTourLog: async (log: { tourId: string; body: string }) => {
          logs.push(log.body);
          write(join(DOC_ROOT, 'tours', `${log.tourId}.md`), log.body);
        },
      },
    }),
  };
}

/** The report a finished Implementer session leaves (§4.2, D-82). */
function reportBody(): ClosingReport {
  return {
    tourId: TOUR,
    commits: [],
    pushed: false,
    jobs: [],
    deviations: [],
    debts: [],
    auditFindings: [],
    notes: 'none',
  };
}

function reportFor(tourId: string): void {
  writeReport(root, { ...reportBody(), tourId });
}

beforeEach(() => {
  dieAfterTransitions = Number.POSITIVE_INFINITY;
  transitionsSeen = 0;
  root = mkdtempSync(join(tmpdir(), 'wardroom-kill-windows-'));
  ensureRunDir(root);
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'f@example.invalid');
  git('config', 'user.name', 'Fixture');
  write(
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
        usage_budget: { usd: 1000 },
        track_runtime: false,
      },
      null,
      2,
    )}\n`,
  );
  write(join(DOC_ROOT, 'SRS.md'), '# SRS\n\nVersion 1.13 · 2026-08-21\n');
  write('README.md', '# fixture\n');
  writeProgress(block);
  commitAll('fixture');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The rows this file has answered, checked against the fixture below. */
const covered = new Set<string>();

/** Names the row a case answers, and refuses one the table does not carry. */
function window(id: string): Window {
  const row = table.windows.find((candidate) => candidate.id === id);
  if (row === undefined) {
    throw new Error(
      `no window ${id} in ${table.source}. The test enumerates the table, never the other way round (D-97).`,
    );
  }
  covered.add(id);
  return row;
}

describe('every window in the §4.4 table is killed and resumed', () => {
  it('status update written, commit not made: the criterion decides and the status does not', async () => {
    window('status-written-commit-not-made');

    // The death: the row says done and no commit carries it, which is the
    // order §4.2 fixes (D-65). Nothing about the file says the commit is
    // missing, which is exactly why the status is not the evidence.
    writeProgress(blockAt(1));
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 1 }));

    const ran: number[] = [];
    const result = await driveExecuting({
      root,
      config: loadConfig(root),
      marker: marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 1 }),
      session: {
        runJob: async (_job: unknown, index: number) => {
          ran.push(index);
        },
        // The criterion of the job whose row says done has not passed: the
        // work was recorded and never committed.
        acceptancePasses: async (_job: unknown, index: number) => ran.includes(index),
      },
      now: NOW,
    });

    // Re-checked and re-run from the first job, not from the row that claims
    // to be behind it.
    expect(result.resumedAt).toBe(0);
    expect(ran).toEqual([0, 1]);
  });

  it('commit made, marker not written: the commit is the fact', () => {
    window('commit-made-marker-not-written');

    const before = head();
    write('src/thing.ts', 'export const thing = 1;\n');
    const after = commitAll('job 1');
    writeMarker(
      root,
      marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0, headCommit: before }),
    );

    const result = resume(root);

    expect(result.headCommitCheck.kind).toBe('behind');
    expect(result.state).toBe('EXECUTING');
    expect(result.marker?.headCommit).toBe(after);
  });

  it('commit made, marker not written: and only where HEAD can reach it (D-100)', () => {
    window('commit-made-marker-not-written');

    // The refinement the same row carries. A commit the repository cannot
    // reach is not late work, so nothing is reconstructed from git.
    writeMarker(
      root,
      marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0, headCommit: 'f'.repeat(40) }),
    );

    const result = resume(root);

    expect(result.headCommitCheck.kind).toBe('unreachable');
    expect(result.state).toBeNull();
    expect(result.marker).toBeNull();
  });

  it('disposition decided, marker not carrying it: the window is closed rather than answered', async () => {
    window('disposition-decided-marker-not-carrying-it');

    // The tour decided carried at the EXECUTING boundary and died in
    // VERIFYING. Under the rule D-101 replaced, nothing on disk said so and
    // the tour closed as an ordinary one.
    writeProgress(blockAt(1));
    commitAll('job 1');
    reportFor(TOUR);
    writeMarker(
      root,
      marker({ state: 'VERIFYING', tourId: TOUR, jobIndex: 1, disposition: 'carried' }),
    );

    const outcome = await runCycle({ root, sessions: sessions().factory, now: NOW });

    expect(outcome.kind).toBe('idle');
    expect(outcome.disposition).toBe('carried');
  });

  it('session ended, report not written: the report is recorded as lost', async () => {
    window('session-ended-report-not-written');

    writeProgress(blockAt(2));
    commitAll('the jobs');
    writeMarker(
      root,
      marker({ state: 'CLOSING', tourId: TOUR, jobIndex: 2, disposition: 'closed' }),
    );
    expect(existsSync(join(wardroomPaths(root).reportsDir, `${TOUR}.md`))).toBe(false);

    const doubles = sessions();
    const outcome = await runCycle({ root, sessions: doubles.factory, now: NOW });

    expect(outcome.kind).toBe('idle');
    expect(doubles.logs[0]).toContain('The report was lost');
    // Named unrecoverable rather than assumed absent: a debt nobody wrote
    // down is the failure the whole procedure exists to prevent.
    expect(doubles.logs[0]).toContain('unrecoverable');
  });

  it('gate decided, authorization not consumed: it still authorizes exactly one call', () => {
    window('gate-decided-authorization-not-consumed');

    const entry = enqueue(root, {
      gateClass: 'push',
      tourId: TOUR,
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'Run `git push origin main`',
      why: 'push is the owner operation',
      preview: {
        kind: 'push',
        commits: [{ hash: head().slice(0, 7), subject: 'fixture' }],
        remote: 'origin',
        branch: 'main',
      },
    });
    decide(root, entry.gateId, 'approved', 'owner');

    // The death is between the decision and the call that spends it, so no
    // `consumed` line exists and the entry still stands.
    expect(readAuditLines(root).some((line) => line.event === 'consumed')).toBe(false);
    const query = {
      gateClass: 'push' as const,
      what: 'Run `git push origin main`',
      tourId: TOUR,
    };

    expect(authorizationFor(root, query)?.gateId).toBe(entry.gateId);
  });

  it('closure commit made, baseline not refreshed: the next tour compares against the older one', () => {
    window('closure-commit-made-baseline-not-refreshed');

    // The baseline exists only where git cannot supply one, so the document
    // root has to be untracked here, as this project's own is (D-8, §3.4).
    write('.gitignore', '/internal/\n');
    git('rm', '-r', '-q', '--cached', 'internal');
    commitAll('untrack the document root');

    recordClosureBaseline(root, loadConfig(root));
    const older = readDocBaseline(root);
    expect(older?.['SRS.md']?.version).toBe('1.13');

    // The closure commit carries the new documents and the refresh never ran.
    write(join(DOC_ROOT, 'SRS.md'), '# SRS\n\nVersion 1.14 · 2026-08-22\n');
    commitAll('closure');

    // Stricter rather than looser: the next tour's commit gate compares the
    // staged document against a baseline that predates it, so it demands the
    // bump and the change-log row it would have demanded anyway.
    expect(readDocBaseline(root)).toEqual(older);
    expect(readDocBaseline(root)?.['SRS.md']?.version).toBe('1.13');
  });

  it('block cleared, closure commit not made: the cleared block waits in the tree', () => {
    window('block-cleared-closure-commit-not-made');

    // Closure clears the block before the commit and not after it (§4.6 step
    // 6), so a death between the two leaves the cleared block uncommitted.
    write(join(DOC_ROOT, 'tours', `${TOUR}.md`), `# ${TOUR}\n\n- **Disposition:** closed\n`);
    writeProgress(null);

    // The tour log is the record of what happened; the block is not.
    expect(existsSync(join(root, DOC_ROOT, 'tours', `${TOUR}.md`))).toBe(true);
    expect(readOpenTour(root, DOC_ROOT).kind).toBe('none');
    expect(git('status', '--porcelain')).toContain('PROGRESS.md');

    // And the next closure commit carries it, rather than the next tour's
    // first commit picking it up (D-65's rule, one level up).
    commitAll('the closure commit that was missed');
    expect(git('status', '--porcelain').trim()).toBe('');
    expect(readOpenTour(root, DOC_ROOT).kind).toBe('none');
  });

  it(`answers every row transcribed from ${table.source} and invents none`, () => {
    // Last, so it runs after the cases above have registered themselves. A
    // file that answered six rows of seven and passed would be the silent gap
    // D-97 exists to close.
    const missing = table.windows.filter((row) => !covered.has(row.id));

    expect(missing.map((row) => row.window)).toEqual([]);
    expect(covered.size).toBe(table.windows.length);
  });
});

/**
 * The other half of K-3: the run really is stopped part way through, at every
 * transition it makes, and picked up again.
 *
 * The death is injected before a marker write, so the marker is left where the
 * previous transition put it, which is the state a killed process leaves. What
 * is asserted is not that each restart lands somewhere plausible but that the
 * tour ends where an uninterrupted one ended: a resumption that reaches a
 * different end state is a resumption that lost or repeated work.
 */
describe('a run killed at each transition reaches the same end as one that was not', () => {
  /**
   * The SDK's `query`, scripted (D-85).
   *
   * The sweep runs over this seam rather than over the driver interfaces,
   * because the drivers are what the tour built and mocking them would leave
   * the assembly, the hook and the meter out of the one test that kills the
   * run. The session does what a real one does through its tools: writes the
   * status into the block, commits it, and answers the acceptance question and
   * the report turn.
   */
  function scriptedSessions() {
    const done = new Set<number>();

    const reply = (prompt: string): string => {
      if (prompt.includes('Write the closing report')) return renderReport(reportBody());

      const asked = /criterion of job (\d+)/.exec(prompt)?.[1];
      if (asked !== undefined) {
        return done.has(Number(asked) - 1) ? `checked\n${PASS}` : `checked\n${FAIL}`;
      }

      const worked = /^Job (\d+) of/.exec(prompt)?.[1];
      if (worked !== undefined) {
        const index = Number(worked) - 1;
        done.add(index);
        // The order §4.2 fixes: the status update rides into the commit
        // (D-65), and the orchestrator advances the marker after it (D-47).
        writeProgress(blockAt(index + 1));
        write(`src/job-${index}.ts`, `export const job${index} = true;\n`);
        commitAll(`job ${index + 1}`);
      }
      return 'done';
    };

    const query = (params: {
      prompt: string | AsyncIterable<SDKUserMessage>;
      options?: Options;
    }) =>
      (async function* (): AsyncGenerator<SDKMessage, void> {
        if (typeof params.prompt === 'string') return;
        let turn = 0;
        for await (const message of params.prompt) {
          turn += 1;
          const text = String((message.message as { content: unknown }).content ?? '');
          yield resultMessage({
            input: turn * 100,
            output: turn * 10,
            costUsd: turn * 0.01,
            text: reply(text),
          });
        }
      })() as unknown as Query;

    const config = loadConfig(root);
    const wiring = createSessionWiring({
      root,
      config,
      query,
      marker: () => markerOnDisk(root),
    });
    return createDriverSessions({ root, config, wiring });
  }

  /** Runs to IDLE, restarting after each simulated death. */
  async function runToIdle(killAfter: number): Promise<{
    outcome: RunOutcome;
    restarts: number;
  }> {
    let outcome: RunOutcome | null = null;
    let restarts = 0;
    dieAfterTransitions = killAfter;
    transitionsSeen = 0;

    for (let attempt = 0; attempt < 24; attempt += 1) {
      outcome = await runCycle({ root, sessions: scriptedSessions(), now: NOW });
      if (outcome.kind === 'idle') return { outcome, restarts };

      // The process died; the next one starts fresh and resumes from disk,
      // which is the whole of FR-1.2. Nothing is carried over in memory.
      restarts += 1;
      dieAfterTransitions = Number.POSITIVE_INFINITY;
      transitionsSeen = 0;
    }
    throw new Error(
      `a cycle killed after ${killAfter} transitions never reached IDLE: ${outcome?.reason ?? ''}`,
    );
  }

  it('reaches IDLE uninterrupted, which is the answer the killed runs are held to', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));

    const { outcome, restarts } = await runToIdle(Number.POSITIVE_INFINITY);

    expect(outcome.kind).toBe('idle');
    expect(outcome.disposition).toBe('closed');
    expect(restarts).toBe(0);
    expect(outcome.marker?.state).toBe('IDLE');
    expect(readOpenTour(root, DOC_ROOT).kind).toBe('none');
  });

  // The transitions one cycle from EXECUTING makes: two job boundaries,
  // jobs-done, green, close. Killed before each of them in turn. Three of
  // these five deadlocked under the identity rule the cross-check used to
  // apply, permanently and with nothing written (D-104).
  for (const killAfter of [0, 1, 2, 3, 4]) {
    it(`reaches the same end when killed before transition ${killAfter + 1}`, async () => {
      writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));

      const { outcome, restarts } = await runToIdle(killAfter);

      expect(restarts).toBeGreaterThan(0);
      expect(outcome.kind).toBe('idle');
      expect(outcome.disposition).toBe('closed');
      // The same end as the uninterrupted run: the tour closed and the block
      // cleared, rather than somewhere merely plausible.
      expect(readOpenTour(root, DOC_ROOT).kind).toBe('none');
      expect(readMarker(root)).toMatchObject({ kind: 'ok', marker: { state: 'IDLE' } });
    });
  }
});
