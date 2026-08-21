import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { ceilingVerdict } from '../../src/loop/ceiling.js';
import { appendUsage } from '../../src/usage/record.js';

/**
 * The usage ceiling at a job boundary (SDD §3.2, SRS FR-1.4, D-66).
 *
 * "Cannot be expected to fit" is measured rather than guessed: the tour closes
 * at the first boundary where the cost already spent, plus the largest single
 * job's cost so far in this tour, reaches the ceiling. At the first boundary
 * the largest job so far is the job just finished, so the rule is defined from
 * job 1 and needs no second configuration field and no fraction nobody chose.
 */

let root: string;

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: 'internal/docs',
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['true'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 2,
  usageBudget: { usd: 10 },
  trackRuntime: false,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-ceiling-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function spend(jobIndex: number | null, usd: number): void {
  appendUsage(root, {
    ts: '2026-08-21T09:00:00.000Z',
    role: 'implementer',
    state: 'EXECUTING',
    tourId: 'tour-9',
    jobIndex,
    tokens: { input: 10, output: 1 },
    usd,
  });
}

function verdict(overrides: Partial<ProjectConfig> = {}) {
  return ceilingVerdict(root, { ...config, ...overrides }, 'tour-9');
}

describe('the rule is spent plus the largest job so far', () => {
  it('is within the ceiling while the sum is under it', () => {
    spend(0, 3);

    // 3 spent, largest job 3, sum 6 against a ceiling of 10.
    expect(verdict().kind).toBe('within');
  });

  it('is reached when the sum meets the ceiling exactly', () => {
    spend(0, 5);

    // 5 spent, largest job 5, sum 10: reached, not exceeded. D-66 says
    // "reaches the ceiling", and a rule that waited for strictly greater would
    // let one more job start on a budget already spent.
    expect(verdict().kind).toBe('reached');
  });

  it('is within by one penny below that', () => {
    spend(0, 4.99);

    expect(verdict().kind).toBe('within');
  });

  it('predicts from the largest job, not the last one', () => {
    // A cheap final job would otherwise let an expensive tour carry on.
    spend(0, 4);
    spend(1, 0.5);

    // 4.5 spent, largest job 4, sum 8.5 against 10: still within, but the
    // prediction is the 4 and not the 0.5.
    const answer = verdict();
    expect(answer.kind === 'within' && answer.largestJobUsd).toBe(4);
  });

  it('counts a session that belongs to no job against what was spent', () => {
    // Planning is spent and is not a job whose size predicts the next one.
    spend(null, 6);
    spend(0, 2);

    // 8 spent, largest job 2, sum 10: reached.
    expect(verdict().kind).toBe('reached');
  });

  it('is within where the tour has spent nothing at all', () => {
    expect(verdict().kind).toBe('within');
  });

  it('reads only this tour', () => {
    appendUsage(root, {
      ts: '2026-08-21T09:00:00.000Z',
      role: 'implementer',
      state: 'EXECUTING',
      tourId: 'tour-8',
      jobIndex: 0,
      tokens: { input: 1, output: 1 },
      usd: 99,
    });

    expect(verdict().kind).toBe('within');
  });
});

describe('an inactive meter never fires and never passes silently', () => {
  it('reports inactive under subscription auth', () => {
    spend(0, 99);

    const answer = verdict({ authMode: 'subscription' });

    expect(answer.kind).toBe('inactive');
    expect(answer.kind === 'inactive' && answer.reason).toMatch(/subscription/);
  });

  it('does not fire, whatever the tour has spent', () => {
    spend(0, 99);

    expect(verdict({ authMode: 'subscription' }).kind).not.toBe('reached');
  });

  it('is not reported as satisfied, which is the point of naming it', () => {
    // D-46: reported as inactive rather than treated as satisfied. A caller
    // that read "not reached" as "within budget" would be told a tour was
    // affordable by a meter that never ran.
    expect(verdict({ authMode: 'subscription' }).kind).not.toBe('within');
  });

  it('reports inactive where the meter is on but nothing carries a cost', () => {
    appendUsage(root, {
      ts: '2026-08-21T09:00:00.000Z',
      role: 'implementer',
      state: 'EXECUTING',
      tourId: 'tour-9',
      jobIndex: 0,
      tokens: { input: 10, output: 1 },
    });

    expect(verdict().kind).toBe('inactive');
  });
});
