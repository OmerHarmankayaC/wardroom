import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir } from '../../src/config/paths.js';
import { UsageMeter } from '../../src/usage/meter.js';
import { readUsage } from '../../src/usage/record.js';
import {
  DEFAULT_SESSION,
  assistantMessage as assistant,
  resultMessage as result,
} from '../support/sdk-messages.js';

/**
 * The meter (SDD §3.0, NFR-4, D-74, D-80, D-84, D-86, D-87).
 *
 * One session spans many jobs, so usage is accumulated as the session's
 * messages arrive and attributed to the job currently open: a job line at each
 * boundary, a session line at the end. The two reading rules are properties of
 * the SDK's shape (Appendix A.4) rather than of Wardroom's design, which is
 * exactly why they are tested here and not assumed: neither is visible from
 * the field names.
 */

let root: string;

const SESSION = DEFAULT_SESSION;
const NOW = () => new Date('2026-08-21T10:00:00.000Z');

function meter() {
  return new UsageMeter({ root, role: 'implementer', tourId: 'tour-9', now: NOW });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-meter-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('usage accumulates per message', () => {
  it('adds each assistant message to the job currently open', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.observe(assistant('msg-2', 50, 10));
    usage.boundary('EXECUTING', 0);

    expect(readUsage(root)[0]?.tokens).toEqual({ input: 150, output: 30 });
  });

  it('counts a turn once when several messages share a message id', () => {
    // A.4: one API assistant turn may emit several assistant messages sharing
    // an id, each with its own timestamp. Summing them counts the turn more
    // than once, and nothing in the field names says so (D-87).
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.observe(assistant('msg-1', 100, 20));
    usage.boundary('EXECUTING', 0);

    expect(readUsage(root)[0]?.tokens).toEqual({ input: 100, output: 20 });
  });

  it('keeps counting different ids after a repeat', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.observe(assistant('msg-1', 100, 20));
    usage.observe(assistant('msg-2', 7, 3));
    usage.boundary('EXECUTING', 0);

    expect(readUsage(root)[0]?.tokens).toEqual({ input: 107, output: 23 });
  });

  it('does not carry the previous job usage into the next', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.boundary('EXECUTING', 0);
    usage.observe(assistant('msg-2', 5, 1));
    usage.boundary('EXECUTING', 1);

    expect(readUsage(root).map((entry) => entry.tokens)).toEqual([
      { input: 100, output: 20 },
      { input: 5, output: 1 },
    ]);
  });

  it('remembers ids across a boundary, since a turn does not end at one', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.boundary('EXECUTING', 0);
    usage.observe(assistant('msg-1', 100, 20));
    usage.boundary('EXECUTING', 1);

    expect(readUsage(root)[1]?.tokens).toEqual({ input: 0, output: 0 });
  });
});

describe('a line is written at each boundary and at session end', () => {
  it('attributes the job line to the job that was open', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 10, 2));
    usage.boundary('EXECUTING', 0);

    expect(readUsage(root)[0]).toMatchObject({
      kind: 'job',
      jobIndex: 0,
      state: 'EXECUTING',
      role: 'implementer',
      tourId: 'tour-9',
    });
  });

  it('writes a session line at the end, belonging to no single job', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 10, 2));
    usage.observe(result({ input: 10, output: 2 }));
    usage.boundary('EXECUTING', 0);
    usage.end('EXECUTING');

    const lines = readUsage(root);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ kind: 'session', jobIndex: null });
  });

  it('carries the session id, so a session line and its job lines are one group', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 10, 2));
    usage.observe(result({ input: 10, output: 2 }));
    usage.boundary('EXECUTING', 0);
    usage.end('EXECUTING');

    expect(readUsage(root).map((entry) => entry.sessionId)).toEqual([SESSION, SESSION]);
  });
});

describe('the session total is modelUsage on the last result', () => {
  it('reads the latest result rather than summing across results', () => {
    // Both fields are cumulative: each result carries the running total so
    // far. Adding them together double counts every earlier turn (D-87).
    const usage = meter();

    usage.observe(result({ input: 100, output: 10, costUsd: 1 }));
    usage.observe(result({ input: 250, output: 25, costUsd: 3 }));
    usage.end('EXECUTING');

    const session = readUsage(root)[0];
    expect(session?.tokens).toEqual({ input: 250, output: 25 });
    expect(session?.usd).toBe(3);
  });

  it('takes modelUsage and not usage, since usage omits the subagents', () => {
    // D-86: `usage` is the main agent loop only. NFR-4 asks what the tour
    // spent, and a total that omits subagents is not that.
    const usage = meter();

    usage.observe(result({ input: 300, output: 30, mainLoopInput: 100 }));
    usage.end('EXECUTING');

    expect(readUsage(root)[0]?.tokens.input).toBe(300);
  });

  it('sums the per-model entries of that one result', () => {
    const usage = meter();
    const twoModels = result({ input: 100, output: 10 }) as unknown as {
      modelUsage: Record<string, unknown>;
    };
    twoModels.modelUsage['claude-haiku-4-5'] = {
      inputTokens: 20,
      outputTokens: 5,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0.5,
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
    };

    usage.observe(twoModels as unknown as SDKMessage);
    usage.end('EXECUTING');

    expect(readUsage(root)[0]?.tokens).toEqual({ input: 120, output: 15 });
  });

  it('meters a session that ended on an error result', () => {
    // The error member carries the totals too, so a run that failed
    // expensively is not reported as having spent nothing (D-88).
    const usage = meter();

    usage.observe(result({ input: 100, output: 10, costUsd: 2, errors: ['it failed'] }));
    usage.end('EXECUTING');

    expect(readUsage(root)[0]?.usd).toBe(2);
  });
});

describe('the gap is recorded as auxiliary, not as drift', () => {
  it('records what the session total holds beyond the accumulated figure', () => {
    // Per-message accumulation reaches the main loop only, so it normally
    // comes in under the session total. That gap is auxiliary usage: subagent,
    // sidechain and internal calls (D-86).
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.observe(result({ input: 260, output: 45 }));
    usage.boundary('EXECUTING', 0);
    usage.end('EXECUTING');

    expect(readUsage(root)[1]?.auxiliary).toEqual({ input: 160, output: 25 });
  });

  it('records no gap where the two agree', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.observe(result({ input: 100, output: 20 }));
    usage.end('EXECUTING');

    expect(readUsage(root)[0]?.auxiliary).toEqual({ input: 0, output: 0 });
  });

  it('records a negative gap rather than clamping it away', () => {
    // Accumulation above the authority is not auxiliary usage, it is a
    // disagreement. Clamping it to zero would hide the one reading that says
    // something is wrong.
    const usage = meter();

    usage.observe(assistant('msg-1', 500, 50));
    usage.observe(result({ input: 100, output: 20 }));
    usage.end('EXECUTING');

    expect(readUsage(root)[0]?.auxiliary).toEqual({ input: -400, output: -30 });
  });

  it('reports the session as not measured where no result ever arrived', () => {
    // Not zero. A session that produced no result did not spend nothing; it
    // was not measured, and the ceiling reader must be able to tell (D-80).
    const usage = meter();

    usage.observe(assistant('msg-1', 100, 20));
    usage.end('EXECUTING');

    const session = readUsage(root)[0];
    expect(session?.usd).toBeUndefined();
    expect(session?.auxiliary).toBeUndefined();
  });
});

describe('a job line costs what the cumulative counter moved by', () => {
  it('differences the cumulative cost across boundaries rather than summing', () => {
    const usage = meter();

    usage.observe(result({ costUsd: 2 }));
    usage.boundary('EXECUTING', 0);
    usage.observe(result({ costUsd: 5 }));
    usage.boundary('EXECUTING', 1);

    expect(readUsage(root).map((entry) => entry.usd)).toEqual([2, 3]);
  });

  it('leaves the cost absent on a job that saw no result at all', () => {
    const usage = meter();

    usage.observe(assistant('msg-1', 10, 2));
    usage.boundary('EXECUTING', 0);

    expect(readUsage(root)[0]?.usd).toBeUndefined();
  });
});
