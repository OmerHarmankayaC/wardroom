import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import {
  type StateMarker,
  type TourState,
  readMarker,
  writeMarker,
} from '../../src/state/marker.js';
import { resume } from '../../src/state/resume.js';

/**
 * Resume after process death (SDD §4.4). The next action is reconstructed from
 * repository files alone (FR-1.2): no orchestrator memory, no agent session.
 *
 * Scope boundary (BACKLOG D-21): step 2's cross-check against the open-tour
 * block in PROGRESS.md is NOT implemented here: it needs a grammar no
 * document fixes yet (B-9). Every result says so rather than implying a
 * completeness it does not have (T-5).
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-resume-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  mkdirSync(join(root, '.wardroom'), { recursive: true });
  writeFileSync(join(root, '.wardroom', 'config.json'), JSON.stringify(config));
  writeFileSync(join(root, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const config = {
  name: 'fixture',
  level: 'full',
  doc_root: 'docs',
  stack: { language: 'TypeScript', runtime: 'node>=18', package_manager: 'npm' },
  verify: ['npm test'],
  auth_mode: 'api_key',
  gate_wait: '24h',
  attempt_budget: 3,
  usage_budget: { usd: 20 },
  track_runtime: true,
};

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function head(): string {
  return git('rev-parse', 'HEAD').trim();
}

function dirtyTheWorkingTree(): void {
  writeFileSync(join(root, 'README.md'), '# fixture, half edited\n');
}

/** Writes a marker for `state`, correct in every respect but the one under test. */
function markerFor(state: TourState, overrides: Partial<StateMarker> = {}): StateMarker {
  const base: StateMarker = {
    state,
    tourId: 'tour-1',
    jobIndex: 1,
    interruptedState: state === 'GATED' || state === 'PARKED' ? 'EXECUTING' : null,
    attemptCount: state === 'FAILED' ? 1 : 0,
    headCommit: head(),
    updatedAt: '2026-08-20T09:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function given(state: TourState, overrides: Partial<StateMarker> = {}): void {
  ensureRunDir(root);
  writeMarker(root, markerFor(state, overrides));
}

function givenUnreadableMarker(): void {
  ensureRunDir(root);
  writeFileSync(wardroomPaths(root).stateFile, '{"state": "EXECUT');
}

describe('resume, per state', () => {
  it('treats an absent marker as a repository Wardroom has never run', () => {
    const result = resume(root);

    expect(result.state).toBe('IDLE');
    expect(result.nextAction).toBe('PLAN_TOUR');
  });

  it('plans a tour from IDLE', () => {
    given('IDLE');

    expect(resume(root).nextAction).toBe('PLAN_TOUR');
  });

  it('discards partial planning output and re-plans from PLANNING', () => {
    given('PLANNING');

    const result = resume(root);

    expect(result.state).toBe('PLANNING');
    expect(result.nextAction).toBe('REPLAN');
  });

  it('resumes the job list from EXECUTING', () => {
    given('EXECUTING');

    const result = resume(root);

    expect(result.state).toBe('EXECUTING');
    expect(result.nextAction).toBe('RESUME_EXECUTION');
  });

  it('re-runs verification from scratch from VERIFYING', () => {
    given('VERIFYING');

    const result = resume(root);

    expect(result.state).toBe('VERIFYING');
    expect(result.nextAction).toBe('RERUN_VERIFICATION');
  });

  it('re-reads the document debts from CLOSING', () => {
    given('CLOSING');

    const result = resume(root);

    expect(result.state).toBe('CLOSING');
    expect(result.nextAction).toBe('RESUME_CLOSING');
  });

  it('re-presents the gate from GATED, never approving it', () => {
    given('GATED');

    const result = resume(root);

    expect(result.state).toBe('GATED');
    expect(result.nextAction).toBe('REPRESENT_GATE');
  });

  it('re-presents the gate from PARKED, however long it has waited', () => {
    given('PARKED', { updatedAt: '2020-01-01T00:00:00.000Z' });

    const result = resume(root);

    expect(result.state).toBe('PARKED');
    expect(result.nextAction).toBe('REPRESENT_GATE');
  });

  it('retries execution from FAILED while the attempt budget holds', () => {
    given('FAILED', { attemptCount: 2 });

    const result = resume(root);

    expect(result.state).toBe('FAILED');
    expect(result.nextAction).toBe('RETRY_EXECUTION');
  });

  it('raises a tour-budget gate from FAILED once the budget is spent', () => {
    given('FAILED', { attemptCount: config.attempt_budget });

    const result = resume(root);

    expect(result.state).toBe('FAILED');
    expect(result.nextAction).toBe('RAISE_TOUR_BUDGET_GATE');
  });
});

describe('an unreadable marker (D-20)', () => {
  it('is never read as IDLE', () => {
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.state).not.toBe('IDLE');
    expect(result.nextAction).not.toBe('PLAN_TOUR');
  });

  it('yields the repository-derived state: a dirty tree is death mid-job', () => {
    givenUnreadableMarker();
    dirtyTheWorkingTree();

    const result = resume(root);

    expect(result.state).toBe('EXECUTING');
    expect(result.nextAction).toBe('RESUME_EXECUTION');
  });

  it('asks for reconstruction when git alone cannot decide', () => {
    givenUnreadableMarker();

    expect(resume(root).nextAction).toBe('RECONSTRUCT_FROM_DOCUMENTS');
  });

  it('preserves the discarded marker beside its replacement for inspection', () => {
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.discardedMarker).not.toBeNull();
    expect(existsSync(result.discardedMarker as string)).toBe(true);
    expect(readdirSync(wardroomPaths(root).runDir).length).toBeGreaterThan(0);
  });

  it('reports the event, because a marker that could not be read is a defect elsewhere', () => {
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.events.some((event) => event.includes('unreadable'))).toBe(true);
  });
});

describe('validation against the repository (SDD §4.4 step 2)', () => {
  it('lets the repository win when the marker names an older commit', () => {
    given('EXECUTING', { headCommit: 'f'.repeat(40) });

    const result = resume(root);

    expect(result.headCommitStale).toBe(true);
    expect(result.headCommit).toBe(head());
    expect(result.marker?.headCommit).toBe(head());
  });

  it('does not flag a marker that agrees with HEAD', () => {
    given('EXECUTING');

    expect(resume(root).headCommitStale).toBe(false);
  });

  it('reports the PROGRESS cross-check as unavailable rather than as done', () => {
    given('EXECUTING');

    const result = resume(root);

    expect(result.progressCrossCheck).toBe('unavailable');
    expect(result.events.some((event) => event.includes('B-9'))).toBe(true);
  });
});

describe('the working tree (SDD §4.4 step 3)', () => {
  it('reports uncommitted work rather than discarding or stashing it', () => {
    given('EXECUTING');
    dirtyTheWorkingTree();

    const result = resume(root);

    expect(result.workingTreeDirty).toBe(true);
    expect(git('status', '--porcelain')).toContain('README.md');
  });

  it("does not count Wardroom's own runtime records as uncommitted work", () => {
    given('EXECUTING');

    const result = resume(root);

    // The marker and the gate queue are the orchestrator's bookkeeping. If they
    // read as a dirty tree, every run would look like death mid-job.
    expect(result.workingTreeDirty).toBe(false);
    expect(git('status', '--porcelain')).toContain('.wardroom/run');
  });

  it('keeps a pending gate in front of the owner even with a dirty tree', () => {
    given('GATED');
    dirtyTheWorkingTree();

    const result = resume(root);

    expect(result.nextAction).toBe('REPRESENT_GATE');
    expect(result.workingTreeDirty).toBe(true);
  });
});

describe('the corrected marker (SDD §4.4 step 5)', () => {
  it('is on disk by the time resume returns, so a second death lands on it', () => {
    given('FAILED', { attemptCount: config.attempt_budget, headCommit: 'f'.repeat(40) });

    const result = resume(root);
    const persisted = readMarker(root);

    expect(persisted).toEqual({ kind: 'ok', marker: result.marker });
    expect(result.marker?.headCommit).toBe(head());
  });

  it('records the reconstructed state after an unreadable marker', () => {
    givenUnreadableMarker();
    dirtyTheWorkingTree();

    resume(root);

    const persisted = readMarker(root);
    expect(persisted.kind === 'ok' && persisted.marker.state).toBe('EXECUTING');
  });

  it('does not invent a marker when the state could not be reconstructed', () => {
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.marker).toBeNull();
    expect(readMarker(root).kind).toBe('absent');
  });
});
