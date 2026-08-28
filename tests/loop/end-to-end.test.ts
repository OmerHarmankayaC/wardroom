import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkCommit } from '../../src/commit/gate.js';
import { loadConfig } from '../../src/config/load.js';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { readDocBaseline } from '../../src/documents/baseline.js';
import { createDriverSessions } from '../../src/loop/driver-sessions.js';
import { FAIL, PASS } from '../../src/loop/prompts.js';
import { runCycle } from '../../src/loop/run.js';
import { createSessionWiring, markerOnDisk } from '../../src/loop/wiring.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  readOpenTour,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { stagedPaths } from '../../src/state/git.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';
import { type ClosingReport, renderReport } from '../../src/state/report.js';
import { readUsage } from '../../src/usage/record.js';
import { resultMessage } from '../support/sdk-messages.js';

/**
 * A tour, end to end, over the scripted SDK seam (SDD §5.1, D-83, D-85).
 *
 * One `run` invocation from `IDLE` back to `IDLE`: the PM plans and writes the
 * block, the Implementer works the job list and commits each job, verification
 * runs the project's own green definition, and closure checks the report
 * against `.git`, writes the tour log, clears the block and commits once.
 *
 * Everything above the SDK call runs for real. What is scripted is `query`,
 * which is where D-85 puts the boundary: a criterion that needed a paid
 * external call is a criterion that quietly stops being checked, and
 * everything Wardroom actually built sits above that line. No case here
 * touches the live API.
 */

const DOC_ROOT = 'internal/docs';
const TOUR = 'tour-9';

let root: string;

const block: OpenTourBlock = {
  tourId: TOUR,
  goal: 'Prove the cycle cycles, over the seam.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.20, BACKLOG 1.23',
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

/** The block with its first `done` rows marked, as a boundary leaves it. */
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

function commitCount(): number {
  return Number(git('rev-list', '--count', 'HEAD').trim());
}

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

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

/** What a finished Implementer session reports (§4.2, D-82, D-102). */
function reportBody(overrides: Partial<ClosingReport> = {}): ClosingReport {
  return {
    tourId: TOUR,
    commits: [],
    pushed: false,
    jobs: block.jobs.map((job) => ({ title: job.title, verdict: 'done' })),
    deviations: [],
    debts: [],
    auditFindings: [],
    notes: 'none',
    ...overrides,
  };
}

interface Script {
  /** Overrides for what the Implementer reports at the end, or null for none. */
  readonly report?: ClosingReport | null;
}

/**
 * The SDK's `query`, scripted, doing through its turns what a real session
 * does through its tools.
 *
 * The order matters and is §4.2's: the status update rides into the job's
 * commit (D-65), and the orchestrator advances the marker after it (D-47).
 */
function wire(script: Script = {}) {
  const done = new Set<number>();
  const turns: string[] = [];

  const reply = (prompt: string): string => {
    turns.push(prompt);

    if (prompt.includes('Plan the next tour')) {
      writeProgress(block);
      commitAll('plan the tour');
      return 'planned';
    }
    if (prompt.includes('Write the closing report')) {
      const report = script.report === undefined ? reportBody() : script.report;
      return report === null ? 'nothing to report' : renderReport(report);
    }
    if (prompt.includes('Write the tour log')) {
      // The orchestrator names the path and hands over the body it assembled
      // from the report and the repository (§4.6 step 4); the session writes
      // it, as the PM would through its tools.
      const path = /to (\S+\.md)/.exec(prompt)?.[1];
      if (path !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, prompt.slice(prompt.indexOf('# ')));
      }
      return 'written';
    }

    const asked = /criterion of job (\d+)/.exec(prompt)?.[1];
    if (asked !== undefined) {
      return done.has(Number(asked) - 1) ? `checked\n${PASS}` : `checked\n${FAIL}`;
    }

    const worked = /^Job (\d+) of/.exec(prompt)?.[1];
    if (worked !== undefined) {
      const index = Number(worked) - 1;
      done.add(index);
      write(`src/job-${index}.ts`, `export const job${index} = true;\n`);
      writeProgress(blockAt(index + 1));
      commitAll(`job ${index + 1}`);
    }
    return 'done';
  };

  const query = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) =>
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
  const wiring = createSessionWiring({ root, config, query, marker: () => markerOnDisk(root) });
  return { turns, sessions: createDriverSessions({ root, config, wiring }) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-end-to-end-'));
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
        // `true` passes, so green is reachable without running a suite inside
        // a suite. The point here is the cycle, not the project's own commands.
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
  write('.gitignore', '/.wardroom/run/\n');
  write(join(DOC_ROOT, 'SRS.md'), '# SRS\n\nVersion 1.13 · 2026-08-21\n');
  write('README.md', '# fixture\n');
  // The repository at a closed boundary: no tour open, nothing uncommitted.
  writeProgress(null);
  commitAll('the repository before the tour');
  writeMarker(root, marker({ state: 'IDLE' }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('one run invocation carries a tour from IDLE to IDLE', () => {
  it('plans, executes, verifies, closes and commits once', async () => {
    const closures: string[] = [];
    const wired = wire();
    const before = commitCount();

    const outcome = await runCycle({
      root,
      sessions: wired.sessions,
      commitClosure: (occasion) => {
        // Gated, as §4.5 gates every commit Wardroom makes. Asked about the
        // real staged set rather than an empty one: the staged set is half of
        // what the gate judges, and a check fed nothing would pass by having
        // nothing to judge.
        git('add', '-A');
        const verdict = checkCommit(
          root,
          loadConfig(root),
          { stagedPaths: stagedPaths(root), occasion },
          { runVerification: () => ({ kind: 'green', ran: ['true'] }) },
        );
        expect(verdict.blocks).toEqual([]);
        // The closure commit carries the cleared block, which is why step 6
        // clears it before step 7 rather than after.
        expect(stagedPaths(root).some((path) => path.endsWith('PROGRESS.md'))).toBe(true);
        closures.push(occasion.tourId);
        commitAll(`close ${occasion.tourId}`);
        return { committed: true, hash: null, blocks: [] };
      },
      now: NOW,
    });

    expect(outcome.kind).toBe('idle');
    expect(outcome.visited).toEqual([
      'IDLE',
      'PLANNING',
      'EXECUTING',
      'VERIFYING',
      'CLOSING',
      'IDLE',
    ]);
    expect(outcome.disposition).toBe('closed');

    // One closure commit, and one commit per job before it.
    expect(closures).toEqual([TOUR]);
    expect(outcome.closureCommitRequested).toBe(true);
    expect(commitCount() - before).toBe(block.jobs.length + 2);

    // The block is cleared and the tour log is the permanent record.
    expect(readOpenTour(root, DOC_ROOT).kind).toBe('none');
    expect(existsSync(join(root, DOC_ROOT, 'tours', `${TOUR}.md`))).toBe(true);
    // No baseline record: the document root is tracked here, as an ordinary
    // managed project's is, so git supplies the baseline and writing one would
    // be a second copy of what `git show` already answers (§3.4, D-30).
    expect(readDocBaseline(root)).toBeNull();
  });

  it('meters the tour it ran, by role and by the state that owned each line', async () => {
    await runCycle({
      root,
      sessions: wire().sessions,
      commitClosure: () => ({ committed: true, hash: null, blocks: [] }),
      now: NOW,
    });

    const lines = readUsage(root);
    const states = new Set(lines.map((line) => line.state));

    expect(states).toEqual(new Set(['PLANNING', 'EXECUTING', 'CLOSING']));
    expect(lines.filter((line) => line.kind === 'job').map((line) => line.jobIndex)).toEqual([
      1, 2,
    ]);
    expect(lines.some((line) => line.role === 'pm')).toBe(true);
    expect(lines.some((line) => line.role === 'implementer')).toBe(true);
  });

  it('checks the report claims against .git and writes the disagreement into the log', async () => {
    // A report is a record and records are not evidence: one that is wrong
    // about what it did is the ordinary case, and closure is the last moment
    // anything checks (§4.6 step 2, D-78).
    const wired = wire({
      report: reportBody({ commits: ['0'.repeat(40)], pushed: true }),
    });

    await runCycle({
      root,
      sessions: wired.sessions,
      commitClosure: () => ({ committed: true, hash: null, blocks: [] }),
      now: NOW,
    });

    const log = readFileSync(join(root, DOC_ROOT, 'tours', `${TOUR}.md`), 'utf8');
    expect(log).toContain('no such object');
    expect(log).toContain('no remote tracking ref');
  });

  it('does not open a second tour after reaching IDLE', async () => {
    const wired = wire();

    await runCycle({
      root,
      sessions: wired.sessions,
      commitClosure: () => ({ committed: true, hash: null, blocks: [] }),
      now: NOW,
    });

    // One planning turn, for this cycle. Continuing would spend the next
    // tour's budget before the owner had seen this one close (D-83).
    expect(wired.turns.filter((turn) => turn.includes('Plan the next tour'))).toHaveLength(1);
  });
});

describe('a tour whose report never arrived closes all the same (D-98)', () => {
  it('records the report as lost and names its debts unrecoverable', async () => {
    // The repository as that death leaves it. The orchestrator writes the
    // report when the session's generator completes (A.4), so a death in that
    // window leaves every acceptance criterion passing, the jobs committed,
    // and no file at all: neither a report nor an aborted record.
    writeProgress(blockAt(block.jobs.length));
    commitAll('the jobs, before the death');
    writeMarker(
      root,
      marker({
        state: 'CLOSING',
        tourId: TOUR,
        jobIndex: block.jobs.length,
        disposition: 'closed',
      }),
    );
    expect(existsSync(join(wardroomPaths(root).reportsDir, `${TOUR}.md`))).toBe(false);

    const outcome = await runCycle({
      root,
      sessions: wire().sessions,
      commitClosure: () => ({ committed: true, hash: null, blocks: [] }),
      now: NOW,
    });

    // The work is committed and green, and an unclosable tour would block
    // every later tour under D-14, so the closure carries on from the block
    // and `.git` rather than stopping.
    expect(outcome.kind).toBe('idle');

    const log = readFileSync(join(root, DOC_ROOT, 'tours', `${TOUR}.md`), 'utf8');
    expect(log).toContain('The report was lost');
    // Named unrecoverable rather than assumed absent: a debt nobody wrote
    // down is the failure the whole procedure exists to prevent, and
    // pretending there were none would be the same failure with better manners.
    expect(log).toContain('unrecoverable');
  });

  it('stops on an aborted record, which says the session did not finish (D-88)', async () => {
    writeProgress(blockAt(block.jobs.length));
    commitAll('the jobs');
    mkdirSync(wardroomPaths(root).reportsDir, { recursive: true });
    writeFileSync(
      join(wardroomPaths(root).reportsDir, `${TOUR}.md`),
      '# Session aborted\n\n## Errors\n\n- the model refused\n',
    );
    writeMarker(
      root,
      marker({
        state: 'CLOSING',
        tourId: TOUR,
        jobIndex: block.jobs.length,
        disposition: 'closed',
      }),
    );

    const outcome = await runCycle({
      root,
      sessions: wire().sessions,
      commitClosure: () => ({ committed: true, hash: null, blocks: [] }),
      now: NOW,
    });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.reason).toMatch(/aborted record/);
  });
});
