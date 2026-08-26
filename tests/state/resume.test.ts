import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import { decide, enqueue, park } from '../../src/gates/queue.js';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  renderOpenTourBlock,
} from '../../src/progress/open-tour.js';
import { writeLastFailure } from '../../src/state/last-failure.js';
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
 * Step 2 reads two records and lets neither correct the other (D-96, D-100):
 * the marker's `tour_id` and `job_index` against the open-tour block. So the
 * fixture writes a block that agrees with the marker, and the cases below that
 * make them disagree do it deliberately.
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
  writeBlock(AGREEING_BLOCK);
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
  default_branch: 'main',
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

/**
 * The block the marker agrees with: one tour, its first job done and its
 * second not, which is `job_index` 1 (SDD §4.4, D-96).
 */
const AGREEING_BLOCK: OpenTourBlock = {
  tourId: 'tour-1',
  goal: 'Prove resumption resumes.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.19, BACKLOG 1.22',
  opened: '2026-08-21',
  jobs: [
    { title: 'First job', criterion: 'the first thing holds', status: 'done' },
    { title: 'Second job', criterion: 'the second thing holds', status: 'pending' },
  ],
  doNotTouch: 'the CLI',
  stopConditions: 'a large deviation',
};

/** Writes the Open tour section, or the statement that no tour is open. */
function writeBlock(open: OpenTourBlock | null): void {
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'PROGRESS.md'),
    [
      '# PROGRESS',
      '',
      '## Open tour',
      '',
      open === null ? NO_OPEN_TOUR_STATEMENT : renderOpenTourBlock(open),
      '',
      '## Done',
      '',
      'none',
      '',
    ].join('\n'),
  );
}

function dirtyTheWorkingTree(): void {
  writeFileSync(join(root, 'README.md'), '# fixture, half edited\n');
}

/** Writes a marker for `state`, correct in every respect but the one under test. */
function markerFor(state: TourState, overrides: Partial<StateMarker> = {}): StateMarker {
  const base: StateMarker = {
    state,
    // The two states that carry no tour: the identifier is minted with the
    // block at the end of planning (§3.3, §4.1 step 7, D-45).
    tourId: state === 'IDLE' || state === 'PLANNING' ? null : 'tour-1',
    jobIndex: state === 'IDLE' || state === 'PLANNING' ? null : 1,
    interruptedState: state === 'GATED' || state === 'PARKED' ? 'EXECUTING' : null,
    attemptCount: state === 'FAILED' ? 1 : 0,
    // A gate-bearing marker names the entry it waits on (SDD §3.3, D-62).
    // The default names one the queue does not hold, which is its own case.
    gateId: state === 'GATED' || state === 'PARKED' ? 'g-20260821T090000Z-none' : null,
    // CLOSING carries the disposition it is closing under, and no other state
    // carries one (SDD §3.3, D-92).
    disposition: state === 'CLOSING' ? 'closed' : null,
    headCommit: head(),
    updatedAt: '2026-08-20T09:00:00.000Z',
  };
  return { ...base, ...overrides };
}

function given(state: TourState, overrides: Partial<StateMarker> = {}): void {
  // A repository at a closed boundary left the block cleared (§4.6 step 6);
  // a marker at IDLE against an open block is a conflict, not a window
  // (D-104). PLANNING keeps the block, which is D-49's adoption seam.
  if (state === 'IDLE') writeBlock(null);
  ensureRunDir(root);
  writeMarker(root, markerFor(state, overrides));
}

/** The failure the attempt count was spent on (SDD §3.0, D-48). */
function givenFailureRecord(attempt: number): void {
  ensureRunDir(root);
  writeLastFailure(root, {
    kind: 'verification',
    attempt,
    command: 'npm run test',
    exitCode: 1,
    output: '3 tests failed',
  });
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
    givenFailureRecord(2);
    given('FAILED', { attemptCount: 2 });

    const result = resume(root);

    expect(result.state).toBe('FAILED');
    expect(result.nextAction).toBe('RETRY_EXECUTION');
  });

  it('raises a tour-budget gate from FAILED once the budget is spent', () => {
    givenFailureRecord(config.attempt_budget);
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

  it('resolves from the block where git alone could not decide, which is T-5 sharpest edge', () => {
    // The case this procedure could not decide until B-9 closed it: a clean
    // tree gives git nothing, and a tour open at a job boundary looked exactly
    // like no tour at all. The block tells them apart by existing (D-96).
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.state).toBe('EXECUTING');
    expect(result.nextAction).toBe('RESUME_EXECUTION');
    // Adopted from the block, which is the only record left saying either.
    expect(result.marker?.tourId).toBe('tour-1');
    expect(result.marker?.jobIndex).toBe(1);
  });

  it('answers IDLE where the section states that no tour is open, which is no tour', () => {
    writeBlock(null);
    git('add', '-A');
    git('commit', '-qm', 'tour closed');
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.state).toBe('IDLE');
    expect(result.nextAction).toBe('PLAN_TOUR');
  });

  it('stops where the block cannot be read either, and leaves the marker where it is', () => {
    // Both records unreadable and a clean tree: nothing left says whether a
    // tour is open. Moving the marker aside here would leave the next run
    // reading an absent marker, and absent means a repository Wardroom has
    // never run, which would abandon the tour silently.
    writeBlock(null);
    writeFileSync(
      join(root, 'docs', 'PROGRESS.md'),
      '# PROGRESS\n\n## Open tour\n\nhalf a block\n',
    );
    git('add', '-A');
    git('commit', '-qm', 'broken block');
    givenUnreadableMarker();

    const result = resume(root);

    expect(result.state).toBeNull();
    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.discardedMarker).toBeNull();
    expect(readMarker(root).kind).toBe('unreadable');
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
  it('lets the repository win where the marker names a commit HEAD can reach', () => {
    const older = head();
    writeFileSync(join(root, 'README.md'), '# fixture, one commit later\n');
    git('add', '-A');
    git('commit', '-qm', 'work completed after the last marker write');
    given('EXECUTING', { headCommit: older });

    const result = resume(root);

    expect(result.headCommitCheck.kind).toBe('behind');
    expect(result.headCommitStale).toBe(true);
    expect(result.headCommit).toBe(head());
    expect(result.marker?.headCommit).toBe(head());
  });

  it('stops where the marker names a commit the repository does not have (D-100)', () => {
    // Not late work: a marker naming work this repository does not have, which
    // is what a history rewrite or the wrong clone leaves. Reconstructing from
    // git would adopt a history the marker says was different.
    given('EXECUTING', { headCommit: 'f'.repeat(40) });

    const result = resume(root);

    expect(result.state).toBeNull();
    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.headCommitCheck.kind).toBe('unreachable');
    expect(result.unresolved.join(' ')).toMatch(/head_commit/);
  });

  it('stops where the marker names a commit HEAD cannot reach', () => {
    const orphan = git(
      'commit-tree',
      `${git('rev-parse', 'HEAD^{tree}').trim()}`,
      '-m',
      'orphan',
    ).trim();
    given('EXECUTING', { headCommit: orphan });

    const result = resume(root);

    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.headCommitCheck.kind).toBe('unreachable');
  });

  it('does not flag a marker that agrees with HEAD', () => {
    given('EXECUTING');

    expect(resume(root).headCommitStale).toBe(false);
  });

  it('reports the two records aligned where they say the same thing (B-9, D-96)', () => {
    given('EXECUTING');

    const result = resume(root);

    expect(result.progressCrossCheck).toEqual({ kind: 'aligned' });
  });

  /**
   * The lag §4.2's write order creates on purpose (D-104).
   *
   * The status update rides into the job's commit (D-65) and the marker is
   * advanced after it (D-47), so a death between the two leaves the block one
   * row ahead. Refusing there was a deadlock at the point a death is most
   * likely, not a detector.
   */
  it('permits the block being exactly one row ahead, which is the committed job', () => {
    writeBlock({
      ...AGREEING_BLOCK,
      jobs: [
        { title: 'First job', criterion: 'a', status: 'done' },
        { title: 'Second job', criterion: 'b', status: 'done' },
        { title: 'Third job', criterion: 'c', status: 'pending' },
      ],
    });
    given('EXECUTING', { jobIndex: 1 });

    const result = resume(root);

    expect(result.progressCrossCheck).toEqual({ kind: 'lagging', markerJobIndex: 1, blockRow: 2 });
    expect(result.state).toBe('EXECUTING');
    expect(result.nextAction).toBe('RESUME_EXECUTION');
    // Resumption proceeds, and where it picks up is step 4's business: the
    // criterion is the evidence, not either record.
    expect(result.marker).not.toBeNull();
  });

  it('stops where the block is two rows ahead, since no window skips a job', () => {
    writeBlock({
      ...AGREEING_BLOCK,
      jobs: [
        { title: 'First job', criterion: 'a', status: 'done' },
        { title: 'Second job', criterion: 'b', status: 'done' },
        { title: 'Third job', criterion: 'c', status: 'pending' },
      ],
    });
    given('EXECUTING', { jobIndex: 0 });

    const result = resume(root);

    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.unresolved.join(' ')).toMatch(/more than one row ahead/);
  });

  it('stops where the marker leads the block, which nothing writes', () => {
    // The invariant: nothing writes the marker before the block, so a marker
    // ahead of it is a lost block write or a hand edit.
    given('EXECUTING', { jobIndex: 2 });

    const result = resume(root);

    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.unresolved.join(' ')).toMatch(/marker cannot lead/);
  });

  it('permits a marker naming a tour against a cleared block, in CLOSING only', () => {
    writeBlock(null);
    given('CLOSING');

    expect(resume(root).progressCrossCheck).toEqual({
      kind: 'block-cleared',
      markerTour: 'tour-1',
    });
    expect(resume(root).nextAction).toBe('RESUME_CLOSING');
  });

  it('stops on a marker naming a tour against a cleared block in any other state', () => {
    writeBlock(null);
    given('EXECUTING');

    const result = resume(root);

    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.unresolved.join(' ')).toMatch(/closure commit/);
  });

  it('permits a block naming a tour against a nameless marker, in PLANNING only', () => {
    given('PLANNING');

    expect(resume(root).progressCrossCheck).toEqual({ kind: 'adopting', blockTour: 'tour-1' });
    expect(resume(root).nextAction).toBe('REPLAN');
  });

  it('stops on a block naming a tour against a nameless marker in any other state', () => {
    // The block is written before the marker at the end of planning, and
    // nowhere else, so this is a window in PLANNING and nothing anywhere else.
    given('VERIFYING', { tourId: null, jobIndex: null });

    const result = resume(root);

    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.unresolved.join(' ')).toMatch(/end of planning/);
  });

  it('is aligned with a block written by hand rather than by the renderer (D-55)', () => {
    // The block a person co-writes is the one this will meet: the fixture
    // above goes through `renderOpenTourBlock`, so on its own it would only
    // show that the writer and the reader agree with each other.
    writeFileSync(
      join(root, 'docs', 'PROGRESS.md'),
      [
        '# PROGRESS',
        '',
        '## Open tour',
        '',
        '### Tour tour-1',
        '',
        '- **Goal:** Prove resumption resumes.',
        '- **Based on:** CHARTER 1.3, SRS 1.13, SDD 1.19, BACKLOG 1.22',
        '- **Opened:** 2026-08-21',
        '',
        '| # | Job | Acceptance criterion | Status |',
        '|---|---|---|---|',
        '| 1 | First job | the first thing holds | done |',
        // Wrapped across two physical lines, as a hand-written block is.
        '| 2 | Second job | the second thing holds, at some',
        '  length that wraps | pending |',
        '',
        '- **Do not touch:** the CLI',
        '- **Stop conditions:** a large deviation',
        '',
      ].join('\n'),
    );
    given('EXECUTING');

    expect(resume(root).progressCrossCheck).toEqual({ kind: 'aligned' });
  });

  it('stops on a tour_id the block does not carry, reporting both readings', () => {
    given('EXECUTING', { tourId: 'tour-2' });

    const result = resume(root);

    expect(result.state).toBeNull();
    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.progressCrossCheck.kind).toBe('conflict');
    // Both readings, neither preferred: that is the whole point of stopping.
    expect(result.unresolved.join(' ')).toContain('tour-2');
    expect(result.unresolved.join(' ')).toContain('tour-1');
  });

  it('compares job_index against the first row not marked done, not against the row count', () => {
    writeBlock({
      ...AGREEING_BLOCK,
      jobs: [
        { title: 'First job', criterion: 'a', status: 'done' },
        { title: 'Second job', criterion: 'b', status: 'in-progress' },
        { title: 'Third job', criterion: 'c', status: 'pending' },
      ],
    });
    given('EXECUTING', { jobIndex: 1 });

    expect(resume(root).progressCrossCheck).toEqual({ kind: 'aligned' });
  });

  it('stops where the marker names a tour and the block does not parse', () => {
    writeFileSync(join(root, 'docs', 'PROGRESS.md'), '# PROGRESS\n\n## Open tour\n\nrubbish\n');
    given('EXECUTING');

    const result = resume(root);

    expect(result.nextAction).toBe('STOP_UNRESOLVED');
    expect(result.progressCrossCheck.kind).toBe('unreadable-block');
  });

  it('compares nothing where neither record names a tour', () => {
    given('IDLE');

    expect(resume(root).progressCrossCheck).toEqual({ kind: 'no-tour' });
    expect(resume(root).nextAction).toBe('PLAN_TOUR');
  });

  it('writes nothing when it stops', () => {
    given('EXECUTING', { tourId: 'tour-2' });
    const before = readMarker(root);

    const result = resume(root);

    expect(result.marker).toBeNull();
    expect(readMarker(root)).toEqual(before);
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
    given('FAILED', { attemptCount: config.attempt_budget });

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
    given('EXECUTING', { tourId: 'tour-2' });

    const result = resume(root);

    expect(result.marker).toBeNull();
  });
});

/**
 * A decision recorded while the process was down (SDD §4.4 step 4, D-38).
 *
 * The CLI decides against the entry file and needs no loop to do it, so a run
 * that comes back can find its gate already answered. Applying that answer is
 * not auto-approval: it is the owner's own decision, made while nobody was
 * listening. Re-presenting it would ask the owner the same question twice.
 */
function raiseGate(at?: Date): string {
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  return enqueue(
    root,
    {
      gateClass: 'push',
      tourId: 'tour-1',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      what: 'Run `git push origin main`',
      why: 'TD-2 classifies git push and remote operations as critical actions',
      preview: {
        kind: 'push',
        commits: [{ hash: 'abc1234', subject: 'feat: something' }],
        remote: 'origin',
        branch: 'main',
      },
    },
    at === undefined ? {} : { now: at },
  ).gateId;
}

describe('FAILED reads the record before the counter (§4.4 step 4)', () => {
  it('re-runs verification where no record survives, whatever the counter says', () => {
    // The divergence this closed: resume decided from the counter alone, so
    // with no record on disk it answered retry or gate where §4.4 says re-run
    // verification, and the drive that takes the step answered otherwise. One
    // decision, two homes, already disagreeing.
    given('FAILED', { attemptCount: config.attempt_budget });

    expect(resume(root).nextAction).toBe('RERUN_VERIFICATION');
  });

  it('re-runs verification below the budget too, for the same reason', () => {
    given('FAILED', { attemptCount: 0 });

    expect(resume(root).nextAction).toBe('RERUN_VERIFICATION');
  });

  it('agrees with the drive that takes the step', () => {
    givenFailureRecord(config.attempt_budget);
    given('FAILED', { attemptCount: config.attempt_budget });

    expect(resume(root).nextAction).toBe('RAISE_TOUR_BUDGET_GATE');
  });
});

describe('a gate decided while the process was down', () => {
  it.each(['GATED', 'PARKED'] as const)('re-presents a still-pending gate from %s', (state) => {
    const gateId = raiseGate();
    given(state, { gateId });

    const result = resume(root);

    expect(result.nextAction).toBe('REPRESENT_GATE');
    expect(result.gate?.gateId).toBe(gateId);
    expect(result.gate?.status).toBe('pending');
  });

  it('re-presents a gate that was parked long ago, never approving it by age', () => {
    const gateId = raiseGate();
    park(root, gateId);
    given('PARKED', { gateId });

    const result = resume(root);

    expect(result.nextAction).toBe('REPRESENT_GATE');
    expect(result.gate?.gateId).toBe(gateId);
    expect(result.gate?.parkedAt).not.toBeNull();
  });

  it('applies an approval recorded while nobody was listening', () => {
    const gateId = raiseGate();
    decide(root, gateId, 'approved', 'owner');
    given('PARKED', { gateId });

    const result = resume(root);

    expect(result.nextAction).toBe('APPLY_GATE_DECISION');
    expect(result.gate?.status).toBe('approved');
    expect(result.state).toBe('PARKED');
  });

  it('applies a rejection the same way, so the class rejection path can run', () => {
    const gateId = raiseGate();
    decide(root, gateId, 'rejected', 'owner', 'not yet');
    given('GATED', { gateId });

    const result = resume(root);

    expect(result.nextAction).toBe('APPLY_GATE_DECISION');
    expect(result.gate?.status).toBe('rejected');
    expect(result.gate?.decisionNote).toBe('not yet');
  });

  it('reads the gate the marker names, not whichever entry sorts last', () => {
    // The directory scan this replaces could not answer here (D-62): both
    // entries are raised inside the same second, so their identifiers sort by
    // their four random characters rather than by order, and a decided entry
    // stays in the directory (D-29) where it can win that comparison. The
    // marker names the one this tour waits on and the ambiguity goes away.
    const sameSecond = new Date('2026-08-21T09:00:00.000Z');
    const settled = raiseGate(sameSecond);
    decide(root, settled, 'approved', 'owner');
    const waiting = raiseGate(sameSecond);
    given('GATED', { gateId: waiting });

    expect(resume(root).gate?.gateId).toBe(waiting);
    expect(resume(root).nextAction).toBe('REPRESENT_GATE');
  });

  it('reads the older entry when that is the one the marker names', () => {
    // The mutation this exists for: falling back to the newest entry would
    // answer with the second gate here, which this tour is not waiting on.
    const older = raiseGate(new Date('2026-08-21T09:00:00.000Z'));
    raiseGate(new Date('2026-08-21T09:00:05.000Z'));
    given('PARKED', { gateId: older });

    expect(resume(root).gate?.gateId).toBe(older);
  });

  it('says so when the marker names a gate the queue does not have', () => {
    given('GATED');

    const result = resume(root);

    expect(result.gate).toBeNull();
    expect(result.events.join('\n')).toMatch(/queue does not hold/i);
  });

  it('consults no gate for a state that is not waiting on one', () => {
    raiseGate();
    given('EXECUTING');

    const result = resume(root);

    expect(result.nextAction).toBe('RESUME_EXECUTION');
    expect(result.gate).toBeNull();
  });
});
