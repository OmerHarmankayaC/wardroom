import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir } from '../../src/config/paths.js';
import { SessionAbortedError, runSession } from '../../src/loop/session.js';
import { readReport, renderReport, reportPath } from '../../src/state/report.js';
import { UsageMeter } from '../../src/usage/meter.js';
import { readUsage } from '../../src/usage/record.js';

/**
 * Consuming one session's stream (SDD §4.2, §4.6, Appendix A.4, D-73, D-82,
 * D-88).
 *
 * A session ends when the generator completes, and nothing else marks it. A
 * result message is a turn boundary: in a streaming-input session one arrives
 * per turn, so a consumer that wrote the report at the first result would
 * write the first turn's text and stop reading.
 */

let root: string;

const TOUR = 'tour-9';
const NOW = () => new Date('2026-08-21T10:00:00.000Z');

const REPORT_BODY = renderReport({
  tourId: TOUR,
  commits: ['abc1234'],
  pushed: false,
  jobs: [{ title: 'First job', verdict: 'done' }],
  deviations: [],
  debts: [],
  auditFindings: [],
  notes: 'nothing else',
});

function assistant(id: string, input: number, output: number): SDKMessage {
  return {
    type: 'assistant',
    session_id: 'session-1',
    message: {
      id,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  } as unknown as SDKMessage;
}

function success(text: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    session_id: 'session-1',
    result: text,
    total_cost_usd: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 1,
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
      },
    },
  } as unknown as SDKMessage;
}

function errorResult(...errors: string[]): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    session_id: 'session-1',
    errors,
    total_cost_usd: 1,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
  } as unknown as SDKMessage;
}

function stream(...messages: SDKMessage[]): AsyncIterable<SDKMessage> {
  return (async function* () {
    for (const message of messages) yield message;
  })();
}

function run(...messages: SDKMessage[]) {
  return runSession({ root, tourId: TOUR, stream: stream(...messages), now: NOW });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-session-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the report is written when the generator completes', () => {
  it('writes the last message to the report path', async () => {
    const outcome = await run(assistant('msg-1', 10, 2), success(REPORT_BODY));

    expect(outcome.kind).toBe('reported');
    expect(readFileSync(reportPath(root, TOUR), 'utf8')).toBe(REPORT_BODY);
  });

  it('writes the last result and not the first, since a result is a turn', async () => {
    // A.4: in streaming input one result arrives per turn. A consumer that
    // treated the first as the session's end would report turn one.
    await run(success('# Tour report, tour-9\n\nthe first turn\n'), success(REPORT_BODY));

    expect(readFileSync(reportPath(root, TOUR), 'utf8')).toBe(REPORT_BODY);
  });

  it('writes nothing before the generator completes', async () => {
    const seen: string[] = [];
    const watched = (async function* () {
      yield success('# Tour report, tour-9\n\nturn one\n');
      // The report path is checked mid-stream: a session that ended here
      // would have written already, and the point is that it has not.
      try {
        seen.push(readFileSync(reportPath(root, TOUR), 'utf8'));
      } catch {
        seen.push('absent');
      }
      yield success(REPORT_BODY);
    })();

    await runSession({ root, tourId: TOUR, stream: watched, now: NOW });

    expect(seen).toEqual(['absent']);
  });

  it('leaves a report closure can read from disk after the run is gone', async () => {
    await run(success(REPORT_BODY));

    // Nothing of the session survives here: this is a fresh read of the file,
    // which is what a killed run's successor would do (§4.4, D-73).
    expect(readReport(root, TOUR)).toMatchObject({ tourId: TOUR, commits: ['abc1234'] });
  });
});

describe('an error result writes an aborted record instead', () => {
  it('records the errors rather than a report', async () => {
    const outcome = await run(assistant('msg-1', 10, 2), errorResult('the tool failed', 'twice'));

    expect(outcome.kind).toBe('aborted');
    const written = readFileSync(reportPath(root, TOUR), 'utf8');
    expect(written).toContain('the tool failed');
    expect(written).toContain('twice');
  });

  it('makes the record unreadable as a report, since it is not one', async () => {
    // D-88: this is the absence of the artifact, not a report with a part
    // missing, and closure must not be able to read it as the latter.
    await run(errorResult('the tool failed'));

    expect(() => readReport(root, TOUR)).toThrow();
  });

  it('reports the session as failed rather than as a finished job list', async () => {
    const outcome = await run(errorResult('the tool failed'));

    expect(outcome.failed).toBe(true);
  });

  it('throws for a caller that must not carry on, naming the tour', async () => {
    const outcome = await run(errorResult('the tool failed'));

    expect(() => outcome.assertCompleted()).toThrow(SessionAbortedError);
    expect(() => outcome.assertCompleted()).toThrow(/tour-9/);
  });

  it('does not throw where the session completed', async () => {
    const outcome = await run(success(REPORT_BODY));

    expect(() => outcome.assertCompleted()).not.toThrow();
  });

  it('treats a success result carrying is_error as the failure it is', async () => {
    // A.4: subtype success with is_error true is the error text, not a report.
    const flagged = success(REPORT_BODY) as unknown as { is_error: boolean };
    flagged.is_error = true;

    const outcome = await run(flagged as unknown as SDKMessage);

    expect(outcome.kind).toBe('aborted');
  });

  it('still meters what the failed session spent', async () => {
    // A run that failed expensively has not spent nothing.
    const meter = new UsageMeter({ root, role: 'implementer', tourId: TOUR, now: NOW });

    await runSession({ root, tourId: TOUR, stream: stream(errorResult('boom')), meter, now: NOW });

    expect(readUsage(root).at(-1)).toMatchObject({ kind: 'session', usd: 1 });
  });
});

describe('a session that produced no result at all', () => {
  it('is aborted, not reported, and says the stream ended without one', async () => {
    const outcome = await run(assistant('msg-1', 10, 2));

    expect(outcome.kind).toBe('aborted');
    expect(readFileSync(reportPath(root, TOUR), 'utf8')).toMatch(/no result/i);
  });
});

describe('the meter is fed from the same stream', () => {
  it('passes every message to the meter it was given', async () => {
    const meter = new UsageMeter({ root, role: 'implementer', tourId: TOUR, now: NOW });

    await runSession({
      root,
      tourId: TOUR,
      stream: stream(assistant('msg-1', 100, 20), success(REPORT_BODY)),
      meter,
      now: NOW,
    });

    expect(readUsage(root).at(-1)).toMatchObject({
      kind: 'session',
      tokens: { input: 10, output: 2 },
      auxiliary: { input: -90, output: -18 },
    });
  });

  it('runs without a meter, since not every session is metered', async () => {
    const outcome = await run(success(REPORT_BODY));

    expect(outcome.kind).toBe('reported');
  });
});
