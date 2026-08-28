import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectRun } from '../../src/api/project.js';
import { runCli } from '../../src/cli/main.js';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { readDocBaseline } from '../../src/documents/baseline.js';
import { FAIL, PASS } from '../../src/loop/prompts.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';
import { type ClosingReport, renderReport } from '../../src/state/report.js';
import { resultMessage } from '../support/sdk-messages.js';

/**
 * A tour that closes with its documents committed (SDD §4.5, §4.6, D-77,
 * D-112).
 *
 * The thing this whole tour exists for. Before it, the gate was described only
 * as a hook, nothing filled the orchestrator's side, and `wardroom run` closed
 * a tour without committing its documents: the tour log, the cleared block and
 * the version bumps sat in the working tree and the run reported success.
 *
 * `projectRun` is driven here rather than `runCycle`, because the committer
 * under test is the one `projectRun` supplies. Passing a committer in would
 * test the harness. Only `query` is scripted, which is where D-85 puts the
 * boundary, and no case here touches the live API.
 *
 * **Every claim about a commit is read from `.git`.** The loop's account of
 * its own commit is a record and not evidence, and this project has been wrong
 * about exactly that more than once.
 */

const DOC_ROOT = 'docs';
const TOUR = 'tour-9';

let root: string;

const block: OpenTourBlock = {
  tourId: TOUR,
  goal: 'Close a tour with its documents.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.24, BACKLOG 1.27',
  opened: '2026-08-21',
  jobs: [{ title: 'First job', criterion: 'the first thing holds', status: 'pending' }],
  doNotTouch: 'the CLI',
  stopConditions: 'a large deviation',
};

function write(path: string, contents: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), contents);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** The subjects `.git` carries, newest first. Nothing here believes anything else. */
function log(): string[] {
  return git('log', '--format=%s')
    .split('\n')
    .filter((line) => line !== '');
}

/** The files one commit carries, read out of the object rather than the index. */
function filesIn(ref: string): string[] {
  return git('show', '--name-only', '--format=', ref)
    .split('\n')
    .filter((line) => line !== '');
}

function srs(version: string, body: string): string {
  return [
    '# Software Requirements Specification',
    '',
    `Version ${version} · 2026-08-21`,
    '',
    '| Version | Date | Change |',
    '|---|---|---|',
    `| ${version} | 2026-08-21 | a change |`,
    '',
    body,
    '',
  ].join('\n');
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

function marker(overrides: Partial<StateMarker>): StateMarker {
  return {
    state: 'IDLE',
    tourId: null,
    jobIndex: null,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: null,
    headCommit: git('rev-parse', 'HEAD').trim(),
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

function reportBody(): ClosingReport {
  return {
    tourId: TOUR,
    commits: [],
    pushed: false,
    jobs: block.jobs.map((job) => ({ title: job.title, verdict: 'done' })),
    deviations: [],
    debts: [],
    auditFindings: [],
    notes: 'none',
  };
}

interface Script {
  /** What the PM writes into SRS while settling debts, or nothing. */
  readonly settle?: () => void;
}

/**
 * The SDK's `query`, scripted, doing through its turns what a real session
 * does through its tools.
 *
 * The sessions commit their own job boundaries, as they do live: that path
 * goes through the `PreToolUse` hook, and this file is about the other caller.
 */
function scriptedQuery(script: Script = {}) {
  const done = new Set<number>();

  const reply = (prompt: string): string => {
    if (prompt.includes('Plan the next tour')) {
      writeProgress(block);
      git('add', '-A');
      git('commit', '-qm', 'plan the tour');
      return 'planned';
    }
    if (prompt.includes('Write the closing report')) return renderReport(reportBody());
    if (prompt.includes('Settle the document debt') || prompt.includes('document debt')) {
      script.settle?.();
      return 'settled';
    }
    if (prompt.includes('Write the tour log')) {
      const path = /to (\S+\.md)/.exec(prompt)?.[1];
      if (path !== undefined) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, prompt.slice(prompt.indexOf('# ')));
      }
      // The PM bumps the documents it settled while it is here, which is what
      // makes the closure commit the one that carries version bumps (§4.6
      // step 3, FR-6.1).
      script.settle?.();
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
      writeProgress({
        ...block,
        jobs: block.jobs.map((job, at) =>
          at <= index ? { ...job, status: 'done' as const } : job,
        ),
      });
      git('add', '-A');
      git('commit', '-qm', `job ${index + 1}`);
    }
    return 'done';
  };

  return (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) =>
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
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-closes-'));
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
  write('.gitignore', '/.wardroom/run/\n');
  // A tracked document root, which is the ordinary managed project: git holds
  // the baseline FR-6.1 compares against, so the version check has something
  // to check at the closure occasion.
  write(join(DOC_ROOT, 'SRS.md'), srs('1.13', '## 1. Overview'));
  write('README.md', '# fixture\n');
  writeProgress(null);
  git('add', '-A');
  git('commit', '-qm', 'the repository before the tour');
  writeMarker(root, marker({ state: 'IDLE' }));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('one run invocation closes a tour and commits its documents', () => {
  it('reaches IDLE with the closure commit in `.git`', async () => {
    const before = log().length;

    const outcome = await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.14', '## 1. Overview, settled')),
      }),
    });

    expect(outcome.kind).toBe('idle');
    expect(outcome.visited).toContain('CLOSING');
    // From the repository. The loop saying it committed is not the commit.
    // Three commits: the plan, the one job, and the closure.
    expect(log().length).toBe(before + 3);
    expect(log()[0]).toMatch(/^chore\(tour-9\): close the tour, closed$/);
  });

  it('carries the documents, the tour log and the cleared block in that commit', async () => {
    await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.14', '## 1. Overview, settled')),
      }),
    });

    const carried = filesIn('HEAD');
    expect(carried).toContain(join(DOC_ROOT, 'SRS.md'));
    expect(carried).toContain(join(DOC_ROOT, 'PROGRESS.md'));
    expect(carried).toContain(join(DOC_ROOT, 'tours', `${TOUR}.md`));
    // The block is cleared in the commit rather than left for the next tour's
    // first commit to pick up (§4.6 step 6, D-65 one level up).
    expect(git('show', `HEAD:${join(DOC_ROOT, 'PROGRESS.md')}`)).toContain(NO_OPEN_TOUR_STATEMENT);
  });

  it('leaves a clean product tree, so nothing of the tour is left behind', async () => {
    await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.14', '## 1. Overview, settled')),
      }),
    });

    // `.wardroom/run/` is ignored here, so the only thing that could be dirty
    // is product, and none of it is.
    expect(git('status', '--porcelain').trim()).toBe('');
  });

  it('commits the version bump, which is what FR-6.1 checks at this occasion', async () => {
    await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.14', '## 1. Overview, settled')),
      }),
    });

    expect(git('show', `HEAD:${join(DOC_ROOT, 'SRS.md')}`)).toContain('Version 1.14');
  });

  it('writes no baseline record, because git supplies the baseline here (D-30)', async () => {
    // The record exists for a document root git cannot answer for. Writing one
    // beside a tracked root would be a second home for a fact git already
    // holds, and the two would disagree the first time anyone touched either.
    await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.14', '## 1. Overview, settled')),
      }),
    });

    expect(readDocBaseline(root)).toBeNull();
  });
});

describe('the check runs at that occasion, and a failing bump is refused', () => {
  it('refuses the closure commit where the document moved without its version', async () => {
    // The discriminating case. Without it, every assertion above would pass
    // against a gate that accepted the closure occasion unconditionally.
    const before = log().length;

    const outcome = await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.13', '## 1. Overview, moved')),
      }),
    });

    expect(outcome.closureCommitRequested).toBe(false);
    // No closure commit exists, whatever the loop says about the tour.
    expect(log().filter((subject) => subject.startsWith('chore(tour-9)'))).toEqual([]);
    // The plan and the job are there; the closure is not.
    expect(log().length).toBe(before + 2);
  });

  it('tells the owner why, rather than reporting a tour that closed', async () => {
    // The tour does reach IDLE: §4.4's table answers this window, with the
    // cleared block uncommitted in the tree and the tour log as the record.
    // What must not happen is the owner being told it closed and nothing else.
    const outcome = await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.13', '## 1. Overview, moved')),
      }),
    });

    expect(outcome.kind).toBe('idle');
    expect(outcome.reason).toMatch(/closure commit was refused/);
    expect(outcome.reason).toContain('SRS.md');
  });

  it('says so through the CLI, in the owner language', async () => {
    const result = await runCli(['run'], {
      cwd: root,
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.13', '## 1. Overview, moved')),
      }),
    });

    expect(result.out.join('\n')).toMatch(/closure commit was refused/);
    expect(result.out.join('\n')).toContain('SRS.md');
  });

  it('leaves the cleared block in the tree, which is what §4.4 answers', async () => {
    await projectRun(root, {
      query: scriptedQuery({
        settle: () => write(join(DOC_ROOT, 'SRS.md'), srs('1.13', '## 1. Overview, moved')),
      }),
    });

    expect(readFileSync(join(root, DOC_ROOT, 'PROGRESS.md'), 'utf8')).toContain(
      NO_OPEN_TOUR_STATEMENT,
    );
    expect(git('status', '--porcelain')).toContain('PROGRESS.md');
  });
});
