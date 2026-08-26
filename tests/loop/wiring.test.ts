import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { decide, list } from '../../src/gates/queue.js';
import { createDriverSessions } from '../../src/loop/driver-sessions.js';
import { FAIL, PASS } from '../../src/loop/prompts.js';
import { runCycle } from '../../src/loop/run.js';
import { createSessionWiring, markerOnDisk } from '../../src/loop/wiring.js';
import { type OpenTourBlock, renderOpenTourBlock } from '../../src/progress/open-tour.js';
import { type StateMarker, writeMarker } from '../../src/state/marker.js';
import { renderReport } from '../../src/state/report.js';
import { readUsage } from '../../src/usage/record.js';
import { assistantMessage, resultMessage } from '../support/sdk-messages.js';

/**
 * The live wiring (SDD §4.2, §3.2, D-99, D-85, NFR-4).
 *
 * Everything below the SDK call runs for real here: the assembly, the
 * `PreToolUse` hook, the `canUseTool` supplier, the meter, the drivers and the
 * run cycle. What is scripted is `query`, which is the one seam D-85 puts the
 * boundary at, so the test exercises everything Wardroom actually built and
 * spends nothing on an account.
 *
 * The two things asserted that nothing else can see: a session belongs to one
 * entry into one state, so a retry after `FAILED` opens a second one rather
 * than sending another turn to the first; and the usage record carries the
 * state that owned each line, which is only well defined because of the first.
 */

const DOC_ROOT = 'internal/docs';
const TOUR = 'tour-9';

let root: string;

const block: OpenTourBlock = {
  tourId: TOUR,
  goal: 'Prove the wiring wires.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.18, BACKLOG 1.21',
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
      open === null ? 'No tour is open.' : renderOpenTourBlock(open),
      '',
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
}

/** One opened session, as the scripted seam saw it. */
interface Opened {
  readonly role: 'pm' | 'implementer';
  readonly turns: string[];
}

/**
 * The SDK's `query`, scripted (D-85).
 *
 * It reads the streaming input the wiring produces and answers one result per
 * turn, which is what A.4 says a result message is. The usage totals it
 * carries are cumulative across turns, as the real ones are, so a consumer
 * that summed results instead of reading the latest would be caught here.
 */
function scriptedQuery(reply: (prompt: string, opened: Opened) => string) {
  const opened: Opened[] = [];

  const query = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    // The role is read off the system prompt, which is the one thing the
    // factory sets per role (SDD §4.2).
    const systemPrompt = String(params.options?.systemPrompt ?? '');
    const record: Opened = {
      role: systemPrompt.includes('Implementer role') ? 'implementer' : 'pm',
      turns: [],
    };
    opened.push(record);

    return (async function* (): AsyncGenerator<SDKMessage, void> {
      let turn = 0;
      let input = 0;
      let output = 0;
      if (typeof params.prompt === 'string') return;
      for await (const message of params.prompt) {
        turn += 1;
        input += 100;
        output += 10;
        const text = String((message.message as { content: unknown }).content ?? '');
        record.turns.push(text);
        yield assistantMessage(`m-${opened.length}-${turn}`, 100, 10);
        yield resultMessage({
          input,
          output,
          costUsd: turn * 0.01,
          text: reply(text, record),
          sessionId: `session-${opened.length}`,
        });
      }
    })() as unknown as Query;
  };

  return { query, opened };
}

function wire(reply: (prompt: string, opened: Opened) => string) {
  const scripted = scriptedQuery(reply);
  const config = loadConfig(root);
  const wiring = createSessionWiring({
    root,
    config,
    query: scripted.query,
    marker: () => markerOnDisk(root),
  });
  return { opened: scripted.opened, sessions: createDriverSessions({ root, config, wiring }) };
}

/**
 * Writes a marker and the block that agrees with it (SDD §4.4, D-104).
 *
 * The rows the marker says are behind it are marked done, which is what a tour
 * that reached that boundary would have left, so the cross-check reads the two
 * records as aligned rather than as a lag or a conflict.
 */
function given(overrides: Partial<StateMarker>): void {
  const at = overrides.jobIndex ?? 0;
  if (overrides.tourId != null) {
    writeProgress({
      ...block,
      jobs: block.jobs.map((job, index) => ({
        ...job,
        status: index < at ? 'done' : job.status,
      })),
    });
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
    headCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

const NOW = () => new Date('2026-08-21T10:00:00.000Z');

/**
 * A report in the grammar the reader parses, so closure has one to read.
 *
 * The Implementer owes a report as its last message (§4.2, D-82), and the
 * orchestrator asks for it as the last turn; this is what a session that
 * answered would produce.
 */
function reportText(): string {
  return renderReport({
    tourId: TOUR,
    commits: [],
    pushed: false,
    jobs: block.jobs.map((job) => ({ title: job.title, verdict: 'done' })),
    deviations: [],
    debts: [],
    auditFindings: [],
    notes: 'none',
  });
}

/** Answers every acceptance question in the affirmative once its job has run. */
function replyRunningEverything(): (prompt: string, opened: Opened) => string {
  const done = new Set<string>();
  return (prompt) => {
    if (prompt.includes('Write the closing report')) return reportText();
    const asked = /job (\d+)/.exec(prompt)?.[1] ?? '';
    if (prompt.includes('Does the acceptance criterion')) {
      return done.has(asked) ? `checked\n${PASS}` : `checked\n${FAIL}`;
    }
    const worked = /^Job (\d+) of/.exec(prompt)?.[1];
    if (worked !== undefined) done.add(worked);
    return 'done';
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-wiring-'));
  ensureRunDir(root);
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'f@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  writeConfig();
  writeProgress(block);
  write('README.md', '# fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the drivers get a session the assembly built', () => {
  it('opens a PM session for PLANNING, an Implementer for the job list, a PM for CLOSING', async () => {
    writeProgress(null);
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'no tour open'], { cwd: root });
    writeMarker(root, marker({ state: 'IDLE' }));
    const jobs = replyRunningEverything();
    const wired = wire((prompt, opened) => {
      if (prompt.includes('Plan the next tour')) {
        writeProgress(block);
        return 'planned';
      }
      return jobs(prompt, opened);
    });

    const outcome = await runCycle({ root, sessions: wired.sessions, now: NOW });

    expect(outcome.kind).toBe('idle');
    expect(wired.opened.map((session) => session.role)).toEqual(['pm', 'implementer', 'pm']);
  });

  it('sends the job list to one Implementer session, turn by turn', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const wired = wire(replyRunningEverything());

    await runCycle({ root, sessions: wired.sessions, now: NOW });

    const implementer = wired.opened.filter((session) => session.role === 'implementer');
    expect(implementer).toHaveLength(1);
    // Two jobs, each asked, worked and asked again.
    expect(implementer[0]?.turns.filter((turn) => turn.startsWith('Job '))).toHaveLength(2);
  });
});

describe('a session belongs to one entry into one state (D-99)', () => {
  it('opens a second Implementer session for a retry after FAILED', async () => {
    // The tour fails verification once, retries, and passes. The retry
    // re-enters EXECUTING, and a re-entry is a new session: the first one has
    // already ended, and NFR-4 attributes usage to the state a session sat in.
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0, attemptCount: 1 }));
    write('.wardroom/config.json', failingThenPassingConfig());
    const wired = wire(replyRunningEverything());

    const outcome = await runCycle({ root, sessions: wired.sessions, now: NOW });

    expect(outcome.visited).toContain('FAILED');
    const implementer = wired.opened.filter((session) => session.role === 'implementer');
    expect(implementer).toHaveLength(2);
    // And the second one is a second session, not the first asked again.
    expect(implementer[0]).not.toBe(implementer[1]);
  });
});

describe('metering is fed from the stream the session actually produced', () => {
  it('writes a job line per boundary and a session line per session, with their states', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const wired = wire(replyRunningEverything());

    await runCycle({ root, sessions: wired.sessions, now: NOW });

    const lines = readUsage(root);
    const jobs = lines.filter((line) => line.kind === 'job');
    const sessionLines = lines.filter((line) => line.kind === 'session');

    expect(jobs.map((line) => line.jobIndex)).toEqual([1, 2]);
    expect(jobs.every((line) => line.state === 'EXECUTING')).toBe(true);
    expect(jobs.every((line) => line.role === 'implementer')).toBe(true);
    // One per session opened: the Implementer's and the closing PM's.
    expect(sessionLines.map((line) => line.state)).toEqual(['EXECUTING', 'CLOSING']);
    expect(sessionLines.every((line) => line.tokens.input > 0)).toBe(true);
  });

  it('reads the cumulative totals rather than summing them (D-87)', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const wired = wire(replyRunningEverything());

    await runCycle({ root, sessions: wired.sessions, now: NOW });

    const implementerSession = readUsage(root).find(
      (line) => line.kind === 'session' && line.state === 'EXECUTING',
    );
    // The scripted stream sends 100 input tokens per turn and reports the
    // running total on every result. The Implementer takes seven turns here,
    // two per job plus the work and the closing report, so the answer is 700;
    // a consumer that added the results together would report 2800.
    expect(implementerSession?.tokens.input).toBe(700);
  });
});

/** A verify list that fails once and then passes, through a marker file. */
function failingThenPassingConfig(): string {
  const flag = join(root, '.wardroom', 'run', 'verified-once');
  return `${JSON.stringify(
    {
      name: 'example',
      level: 'full',
      doc_root: DOC_ROOT,
      default_branch: 'main',
      stack: { language: 'TypeScript', runtime: 'node>=18', package_manager: 'npm' },
      verify: [`sh -c 'test -f ${flag} || { touch ${flag}; exit 1; }'`],
      auth_mode: 'api_key',
      gate_wait: '24h',
      attempt_budget: 3,
      usage_budget: { usd: 1000 },
      track_runtime: false,
    },
    null,
    2,
  )}\n`;
}

/**
 * Where the two halves meet.
 *
 * The interception hook and the block guard are exercised against calls this
 * suite hands them, and the wiring is exercised against a session that makes
 * no calls at all. Either check alone passes while the wiring installs
 * something else, or nothing, on the sessions it builds: the assembly refuses a
 * session with no `PreToolUse` hook, so an absent one would be caught, and a
 * hook that is not this interceptor would not (D-55).
 */
describe('a session the wiring built is intercepted and supplied', () => {
  /** The wiring, plus the options every session it opened was built with. */
  function wiredWithoutReplies(): {
    seen: Options[];
    sessions: ReturnType<typeof createDriverSessions>;
  } {
    const seen: Options[] = [];
    const config = loadConfig(root);
    const wiring = createSessionWiring({
      root,
      config,
      marker: () => markerOnDisk(root),
      query: (params) => {
        seen.push(params.options as Options);
        return (async function* (): AsyncGenerator<SDKMessage, void> {
          if (typeof params.prompt === 'string') return;
          for await (const _message of params.prompt) {
            yield resultMessage({ text: 'done' });
          }
        })() as unknown as Query;
      },
    });
    return { seen, sessions: createDriverSessions({ root, config, wiring }) };
  }

  it('installs the interception hook and the supplier on every session it opens', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const built = wiredWithoutReplies();

    const opened = built.sessions.executing(TOUR);
    // A job turn rather than the acceptance question: this case is about what
    // the session was built with, and the acceptance answer has a grammar of
    // its own that a reply of "done" does not meet (D-103).
    await opened.session.runJob(block.jobs[0] as never, 0);
    await opened.close();

    expect(built.seen).not.toHaveLength(0);
    for (const options of built.seen) {
      expect(options.hooks?.PreToolUse?.[0]?.hooks?.length ?? 0).toBeGreaterThan(0);
      expect(typeof options.canUseTool).toBe('function');
      // And the guarantees those two rest on (D-53, SDD §4.2).
      expect(options.settingSources).toEqual([]);
      expect(options.permissionMode).toBe('default');
    }
  });

  it('denies a push through the hook it installed, without the session having to ask', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const built = wiredWithoutReplies();

    const opened = built.sessions.executing(TOUR);
    // A job turn rather than the acceptance question: this case is about what
    // the session was built with, and the acceptance answer has a grammar of
    // its own that a reply of "done" does not meet (D-103).
    await opened.session.runJob(block.jobs[0] as never, 0);
    await opened.close();

    const hook = built.seen[0]?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    expect(hook).toBeDefined();

    // The gate is raised and the call blocks on the owner, so the decision is
    // made from outside while the hook waits, which is what a gate is.
    const held = (hook as NonNullable<typeof hook>)(
      {
        session_id: 's-1',
        transcript_path: '/dev/null',
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        tool_use_id: 'tu-1',
      } as never,
      'tu-1',
      { signal: new AbortController().signal },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    const entries = list(root);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.gateClass).toBe('push');
    // The preview was built by the orchestrator, not by the classifier, and it
    // names the commits the push would carry.
    expect(entries[0]?.preview.kind).toBe('push');

    decide(root, entries[0]?.gateId ?? '', 'rejected', 'owner');
    const answer = (await held) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });

  it('denies every call where the marker cannot be read, rather than throwing out of the hook', async () => {
    writeMarker(root, marker({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 }));
    const built = wiredWithoutReplies();
    const opened = built.sessions.executing(TOUR);
    // A job turn rather than the acceptance question: this case is about what
    // the session was built with, and the acceptance answer has a grammar of
    // its own that a reply of "done" does not meet (D-103).
    await opened.session.runJob(block.jobs[0] as never, 0);
    await opened.close();

    // The marker is read on the hot path by the block guard and by the gate
    // path both. An orchestrator that cannot say where it is has no basis for
    // letting anything through, and a hook that throws instead of answering
    // leaves the SDK with no rule to apply.
    writeFileSync(wardroomPaths(root).stateFile, '{ truncated');

    const hook = built.seen[0]?.hooks?.PreToolUse?.[0]?.hooks?.[0];
    const answer = (await (hook as NonNullable<typeof hook>)(
      {
        session_id: 's-1',
        transcript_path: '/dev/null',
        cwd: root,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'git push origin main' },
        tool_use_id: 'tu-2',
      } as never,
      'tu-2',
      { signal: new AbortController().signal },
    )) as { hookSpecificOutput?: { permissionDecision?: string } };

    expect(answer.hookSpecificOutput?.permissionDecision).toBe('deny');
  });
});

/**
 * An answer the loop cannot read stops the run (SDD §4.2, D-103).
 *
 * The whole path, from the question the orchestrator asks to the stop the
 * owner sees, because the two halves were written in different modules and
 * only the run shows them meeting.
 */
describe('an acceptance answer with neither token stops the run', () => {
  it('stops rather than reading prose as a verdict, and says what it was given', async () => {
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    // A session that answers the acceptance question in prose. Reading it as
    // failing would redo a job that was done, and reading it as passing would
    // skip one that was not.
    const wired = wire((prompt) =>
      prompt.includes('Does the acceptance criterion') ? 'Yes, it holds.' : 'done',
    );

    const outcome = await runCycle({ root, sessions: wired.sessions, now: NOW });

    expect(outcome.kind).toBe('stopped');
    expect(outcome.reason).toMatch(/neither/);
    expect(outcome.reason).toContain('Yes, it holds.');
  });

  it('runs the job list where the answers carry the token', async () => {
    // The other direction, so the case above is not passing because nothing
    // works: the same path with the grammar met runs the tour to IDLE.
    given({ state: 'EXECUTING', tourId: TOUR, jobIndex: 0 });
    const wired = wire(replyRunningEverything());

    const outcome = await runCycle({ root, sessions: wired.sessions, now: NOW });

    expect(outcome.kind).toBe('idle');
  });
});
