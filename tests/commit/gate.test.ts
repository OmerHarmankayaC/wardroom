import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type CommitOccasion,
  type JobBoundaryOccasion,
  WIP_SUBJECT_PREFIX,
  checkCommit,
} from '../../src/commit/gate.js';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { recordClosureBaseline } from '../../src/documents/baseline.js';
import { type StateMarker, readMarker, writeMarker } from '../../src/state/marker.js';
import type { VerificationResult, VerifyRunner } from '../../src/verify/run.js';

/**
 * The commit gate (SDD §4.5, FR-6.1, FR-7.1).
 *
 * Two fixtures, because the two baselines are two different mechanisms: a
 * project whose document root git carries, and one whose document root it does
 * not. The second is this repository (BACKLOG D-8) and is the case a
 * version-only baseline silently passed, which is why D-30 put a hash in the
 * record.
 */

let root: string;

const TRACKED_DOCS = 'docs';
const UNTRACKED_DOCS = 'internal/docs';

function configFor(docRoot: string): ProjectConfig {
  return {
    name: 'example',
    level: 'full',
    docRoot,
    defaultBranch: 'main',
    stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
    // A green definition that passes in an empty temporary repository, so the
    // cases about documents and occasions are not also cases about a suite.
    // The gate runs this list for real at every job boundary (D-58); the tests
    // that are about the run inject their own answer instead.
    verify: ['true'],
    authMode: 'api_key',
    gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
    attemptBudget: 3,
    usageBudget: { usd: 20 },
    trackRuntime: false,
  };
}

/** A document in the shape every canonical document in this project uses. */
function srs(version: string, body = '## 1. Overview'): string {
  return [
    '# Software Requirements Specification',
    '',
    `Version ${version} · 2026-08-20`,
    '',
    '| Version | Date | Change |',
    '|---|---|---|',
    `| ${version} | 2026-08-20 | a change |`,
    '',
    body,
    '',
  ].join('\n');
}

/** The same document with a version bump that has no change-log row. */
function srsWithoutRow(version: string): string {
  return srs('1.3').replace('Version 1.3', `Version ${version}`);
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function write(relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

const boundary: JobBoundaryOccasion = {
  kind: 'job-boundary',
  tourId: 'tour-2',
  jobIndex: 6,
};

/**
 * The marker the gate checks a named occasion against (D-115).
 *
 * Written to disk rather than passed in, because the whole point of the rule
 * is that the caller's claim is checked against something the caller does not
 * supply. Every case below therefore sets the orchestrator's state as well as
 * the request, and the two disagreeing is itself a case.
 */
function markerAt(overrides: Partial<StateMarker> = {}): StateMarker {
  return {
    state: 'EXECUTING',
    tourId: boundary.tourId,
    jobIndex: boundary.jobIndex,
    interruptedState: null,
    attemptCount: 0,
    gateId: null,
    disposition: null,
    headCommit: null,
    updatedAt: '2026-08-21T09:00:00.000Z',
    ...overrides,
  };
}

/** Puts the orchestrator where the request says it is. */
function orchestratorAt(overrides: Partial<StateMarker> = {}): void {
  writeMarker(root, markerAt(overrides));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-commit-'));
  mkdirSync(wardroomPaths(root).runDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write('README.md', '# example\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'initial commit');
  // The default: at the job boundary `boundary` names, which is the occasion
  // most cases here are about. A case about another occasion moves it.
  orchestratorAt();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A repository whose document root git carries: the baseline is HEAD. */
function withTrackedDocuments(version: string): ProjectConfig {
  write(join(TRACKED_DOCS, 'SRS.md'), srs(version));
  git('add', '-A');
  git('commit', '-q', '-m', 'add documents');
  return configFor(TRACKED_DOCS);
}

/** A repository whose document root git ignores: the baseline is the record. */
function withUntrackedDocuments(version: string): ProjectConfig {
  const config = configFor(UNTRACKED_DOCS);
  write(join(UNTRACKED_DOCS, 'SRS.md'), srs(version));
  write('.gitignore', `/${UNTRACKED_DOCS.split('/')[0]}/\n`);
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'ignore the document root');
  recordClosureBaseline(root, config);
  return config;
}

const stagedSrs = (docRoot: string) => [join(docRoot, 'SRS.md')];

describe('document integrity against a tracked document root', () => {
  it('allows a change whose version was bumped and logged', () => {
    const config = withTrackedDocuments('1.3');
    write(join(TRACKED_DOCS, 'SRS.md'), srs('1.4'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict).toEqual({
      allowed: true,
      blocks: [],
      baselineSource: 'head',
      greenSource: 'run',
    });
  });

  it('allows a commit that touches no canonical document', () => {
    const config = withTrackedDocuments('1.3');
    write('src/thing.ts', 'export const thing = 1;\n');

    const verdict = checkCommit(root, config, {
      stagedPaths: ['src/thing.ts'],
      occasion: boundary,
    });

    expect(verdict).toMatchObject({ allowed: true, baselineSource: 'none' });
  });

  it('blocks content that moved while the version stood still', () => {
    const config = withTrackedDocuments('1.3');
    write(join(TRACKED_DOCS, 'SRS.md'), srs('1.3', '## 1. Overview and scope'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('SRS.md');
    expect(verdict.blocks[0]).toContain('1.3');
  });

  it('blocks a version bump with no change-log row for it', () => {
    const config = withTrackedDocuments('1.3');
    write(join(TRACKED_DOCS, 'SRS.md'), srsWithoutRow('1.4'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('change-log row');
  });

  it('does not check a document that is not in the staged set', () => {
    const config = withTrackedDocuments('1.3');
    write(join(TRACKED_DOCS, 'SRS.md'), srs('1.3', '## edited but not staged'));

    const verdict = checkCommit(root, config, {
      stagedPaths: ['README.md'],
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(true);
  });

  it('allows a document HEAD does not carry yet, because it has no baseline', () => {
    const config = withTrackedDocuments('1.3');
    write(join(TRACKED_DOCS, 'SDD.md'), srs('1.0'));

    const verdict = checkCommit(root, config, {
      stagedPaths: [join(TRACKED_DOCS, 'SDD.md')],
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(true);
  });
});

describe('document integrity against an untracked document root (BACKLOG D-30)', () => {
  it('blocks an edit that moved the content and left the version alone', () => {
    // The case a version-only baseline passed. The only version available to
    // compare a recorded version against is the one written inside the
    // document being checked, so the two always agree and the check reports
    // clean. The hash is what makes this detectable at all.
    const config = withUntrackedDocuments('1.3');
    write(join(UNTRACKED_DOCS, 'SRS.md'), srs('1.3', '## 1. Overview and scope'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(UNTRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.baselineSource).toBe('doc-baseline.json');
    expect(verdict.blocks[0]).toContain('SRS.md');
    expect(verdict.blocks[0]).toContain('doc-baseline.json');
  });

  it('confirms the recorded version alone would not have caught it', () => {
    const config = withUntrackedDocuments('1.3');
    const edited = srs('1.3', '## 1. Overview and scope');
    write(join(UNTRACKED_DOCS, 'SRS.md'), edited);

    // Both sides of a version-only comparison read 1.3, which is the whole
    // point: that check can only ever compare a number against itself.
    const recorded = JSON.parse(
      execFileSync('cat', [wardroomPaths(root).docBaselineFile], { encoding: 'utf8' }),
    );
    expect(recorded['SRS.md'].version).toBe('1.3');
    expect(edited).toContain('Version 1.3');

    expect(
      checkCommit(root, config, {
        stagedPaths: stagedSrs(UNTRACKED_DOCS),
        occasion: boundary,
      }).allowed,
    ).toBe(false);
  });

  it('allows a change whose version was bumped and logged', () => {
    const config = withUntrackedDocuments('1.3');
    write(join(UNTRACKED_DOCS, 'SRS.md'), srs('1.4'));

    expect(
      checkCommit(root, config, {
        stagedPaths: stagedSrs(UNTRACKED_DOCS),
        occasion: boundary,
      }),
    ).toEqual({
      allowed: true,
      blocks: [],
      baselineSource: 'doc-baseline.json',
      greenSource: 'run',
    });
  });

  it('blocks a version bump with no change-log row for it', () => {
    const config = withUntrackedDocuments('1.3');
    write(join(UNTRACKED_DOCS, 'SRS.md'), srsWithoutRow('1.4'));

    expect(
      checkCommit(root, config, {
        stagedPaths: stagedSrs(UNTRACKED_DOCS),
        occasion: boundary,
      }).blocks[0],
    ).toContain('change-log row');
  });

  it('allows any document when no tour has closed and there is no record yet', () => {
    const config = configFor(UNTRACKED_DOCS);
    write(join(UNTRACKED_DOCS, 'SRS.md'), srs('1.3'));
    write('.gitignore', '/internal/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore the document root');

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(UNTRACKED_DOCS),
      occasion: boundary,
    });

    // No baseline is not a skipped rule: a document with nothing to differ
    // from has nothing for its version to have to differ from either. The
    // verdict says which it was, so "nothing to compare" is never read as
    // "compared and clean".
    expect(verdict).toEqual({
      allowed: true,
      blocks: [],
      baselineSource: 'no-baseline',
      greenSource: 'run',
    });
  });

  it('leaves PROGRESS outside the rule, because the level says so', () => {
    const config = configFor(UNTRACKED_DOCS);
    write(join(UNTRACKED_DOCS, 'PROGRESS.md'), '# PROGRESS\n\n## Repo\n');
    write('.gitignore', '/internal/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore the document root');
    recordClosureBaseline(root, config);
    write(join(UNTRACKED_DOCS, 'PROGRESS.md'), '# PROGRESS\n\n## Repo\n\n## Open tour\n');

    const verdict = checkCommit(root, config, {
      stagedPaths: [join(UNTRACKED_DOCS, 'PROGRESS.md')],
      occasion: boundary,
    });

    // PROGRESS is canonical at every level and carries neither a version nor a
    // change log by design (SRS §3.2, D-31). It is not a document the check
    // looked at and cleared: it is not in the set the check reads at all.
    expect(verdict).toEqual({
      allowed: true,
      blocks: [],
      baselineSource: 'none',
      greenSource: 'run',
    });
  });

  it('still leaves PROGRESS outside the rule when a version block appears in it', () => {
    // The mutation check. A set inferred from the file would pull PROGRESS in
    // here and block a commit that touches the state carrier, which is exactly
    // the failure D-31 names: a rule whose reach is read out of the file being
    // checked.
    const config = configFor(UNTRACKED_DOCS);
    write(join(UNTRACKED_DOCS, 'PROGRESS.md'), srs('1.3'));
    write('.gitignore', '/internal/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore the document root');
    recordClosureBaseline(root, config);
    write(join(UNTRACKED_DOCS, 'PROGRESS.md'), srs('1.3', '## edited without a bump'));

    expect(
      checkCommit(root, config, {
        stagedPaths: [join(UNTRACKED_DOCS, 'PROGRESS.md')],
        occasion: boundary,
      }),
    ).toEqual({ allowed: true, blocks: [], baselineSource: 'none', greenSource: 'run' });
  });

  it('blocks a version-carrying document whose version block was deleted', () => {
    // The other half of the mutation check. Under the inference this replaces,
    // deleting the block exempted the document, so the enforcement could be
    // switched off by editing the thing it enforces.
    const config = withUntrackedDocuments('1.3');
    write(join(UNTRACKED_DOCS, 'SRS.md'), '# Software Requirements Specification\n\n## 1.\n');

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(UNTRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('SRS.md');
    expect(verdict.blocks[0]).toContain('no version block');
  });
});

describe('the closure occasion (FR-7.1, D-76)', () => {
  const closure = {
    kind: 'closure' as const,
    tourId: 'tour-9',
    disposition: 'closed' as const,
  };

  /** Puts the orchestrator in CLOSING, which is what makes this occasion real. */
  function atClosure(
    disposition: 'closed' | 'abandoned' | 'carried' = 'closed',
    tourId = closure.tourId,
  ): void {
    orchestratorAt({ state: 'CLOSING', tourId, jobIndex: null, disposition });
  }

  it('accepts the one commit a tour closes with', () => {
    const config = withTrackedDocuments('1.3');
    atClosure();

    const verdict = checkCommit(root, config, { stagedPaths: [], occasion: closure });

    expect(verdict.allowed).toBe(true);
  });

  it('is the only occasion whose staged set may carry the document root', () => {
    // Closure carries the version bumps FR-6.1 checks. As FR-7.1 was written
    // before D-76, the gate would have blocked the one commit of a tour whose
    // whole purpose is the integrity check the gate performs.
    const config = withTrackedDocuments('1.3');
    atClosure();
    write(join(TRACKED_DOCS, 'SRS.md'), srs('1.4', '## 1. Overview, rewritten'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: closure,
    });

    expect(verdict.allowed).toBe(true);
  });

  it('still checks the documents it carries', () => {
    // Accepting the occasion is not accepting the contents. A closure commit
    // whose document moved without its version is the exact failure FR-6.1
    // exists for, arriving at the one commit that carries documents.
    const config = withTrackedDocuments('1.3');
    atClosure();
    write(join(TRACKED_DOCS, 'SRS.md'), srs('1.3', '## 1. Overview, rewritten'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: closure,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toContain('SRS.md');
  });

  it('refuses a closure the marker says is a job boundary (D-115)', () => {
    // The caller may name its occasion and the gate checks the claim. The
    // orchestrator here is mid-tour, so a commit calling itself a closure is a
    // tour committing its documents without having been through the procedure
    // that settles them (§4.6).
    const config = withTrackedDocuments('1.3');
    orchestratorAt();

    const verdict = checkCommit(root, config, { stagedPaths: [], occasion: closure });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toMatch(/closure/);
    expect(verdict.blocks.join('\n')).toMatch(/job-boundary/);
    expect(verdict.blocks.join('\n')).toMatch(/D-115/);
  });

  it('refuses a closure whose disposition the marker does not carry (D-115)', () => {
    const config = withTrackedDocuments('1.3');
    atClosure('carried');

    const verdict = checkCommit(root, config, { stagedPaths: [], occasion: closure });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toMatch(/disposition/);
  });

  it('refuses a closure for a tour the marker is not closing (D-115)', () => {
    const config = withTrackedDocuments('1.3');
    atClosure('closed', 'tour-8');

    const verdict = checkCommit(root, config, { stagedPaths: [], occasion: closure });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toMatch(/tour-8/);
  });

  it('runs no green definition, because the tour was verified before it got here', () => {
    // An abandoned closure is the closure of a tour that could not go green
    // (D-35), so requiring green here would forbid the closure the disposition
    // exists for.
    let ran = 0;
    const config = withTrackedDocuments('1.3');
    atClosure('abandoned');
    const verdict = checkCommit(
      root,
      config,
      { stagedPaths: [], occasion: { ...closure, disposition: 'abandoned' } },
      {
        runVerification: () => {
          ran += 1;
          return { kind: 'green', ran: [] };
        },
      },
    );

    expect(ran).toBe(0);
    expect(verdict.greenSource).toBe('not-required');
    expect(verdict.allowed).toBe(true);
  });

  it('names the three occasions when it refuses one that is none of them', () => {
    const verdict = checkCommit(root, withTrackedDocuments('1.3'), {
      stagedPaths: [],
      occasion: { kind: 'checkpoint' },
    });

    expect(verdict.blocks.join('\n')).toMatch(/job-boundary/);
    expect(verdict.blocks.join('\n')).toMatch(/closure/);
    expect(verdict.blocks.join('\n')).toMatch(/wip-stop/);
  });
});

describe('a deleted version-carrying document blocks the commit (D-40)', () => {
  it('blocks a staged deletion against a tracked document root', () => {
    // The skip this replaces was worse than it looks: a deleted file has no
    // version and no content to compare, so the check reported clean, and the
    // one edit that removes a canonical document entirely was the one edit it
    // let past (SRS FR-6.1, SDD §4.5).
    const config = withTrackedDocuments('1.3');
    git('rm', '-q', join(TRACKED_DOCS, 'SRS.md'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toContain('SRS.md');
    expect(verdict.blocks.join('\n')).toMatch(/delet/i);
  });

  it('blocks a staged deletion against a recorded baseline', () => {
    const config = withUntrackedDocuments('1.3');
    rmSync(join(root, UNTRACKED_DOCS, 'SRS.md'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(UNTRACKED_DOCS),
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toContain('SRS.md');
  });

  it('does not block a document that was never there to delete', () => {
    // A document the level names, absent from the staged set entirely, is not
    // a deletion: nothing about it is being committed.
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, { stagedPaths: [], occasion: boundary });

    expect(verdict.allowed).toBe(true);
  });

  it('does not block PROGRESS, which the level leaves outside the set', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, {
      stagedPaths: [join(TRACKED_DOCS, 'PROGRESS.md')],
      occasion: boundary,
    });

    expect(verdict.allowed).toBe(true);
  });
});

describe('the occasion (FR-7.1)', () => {
  it('allows a job boundary that passed and is green', () => {
    const config = withTrackedDocuments('1.3');

    expect(checkCommit(root, config, { stagedPaths: [], occasion: boundary }).allowed).toBe(true);
  });

  it('blocks a job boundary that is not green', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(
      root,
      config,
      { stagedPaths: [], occasion: boundary },
      {
        runVerification: () => ({
          kind: 'failed',
          failure: { command: 'true', exitCode: 1, output: 'a test failed' },
          ran: ['true'],
        }),
      },
    );

    expect(verdict.blocks[0]).toContain('not green');
  });

  it('reports no-baseline rather than naming a record that is not there', () => {
    const config = configFor(UNTRACKED_DOCS);
    write(join(UNTRACKED_DOCS, 'SRS.md'), srs('1.3'));
    write('.gitignore', '/internal/\n');
    git('add', '.gitignore');
    git('commit', '-q', '-m', 'ignore the document root');

    expect(
      checkCommit(root, config, { stagedPaths: stagedSrs(UNTRACKED_DOCS), occasion: boundary })
        .baselineSource,
    ).toBe('no-baseline');
  });

  it('blocks a checkpoint commit and names the two occasions it expected', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'checkpoint' },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('checkpoint');
    expect(verdict.blocks[0]).toContain('job boundary');
    expect(verdict.blocks[0]).toContain('WIP commit');
  });

  it.each(['per-file', 'periodic', 'save-progress', ''])('blocks the %s occasion', (kind) => {
    const config = withTrackedDocuments('1.3');

    expect(checkCommit(root, config, { stagedPaths: [], occasion: { kind } }).allowed).toBe(false);
  });

  it('allows a WIP stop on a branch off the default one', () => {
    const config = withTrackedDocuments('1.3');
    git('checkout', '-q', '-b', 'wip/tour-2');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 6' },
    });

    expect(verdict.allowed).toBe(true);
  });

  it('blocks a WIP stop on the default branch, naming the branch and the rule (D-33)', () => {
    // FR-7.1's second occasion is a single WIP commit on a branch other than
    // default_branch. Unfinished work on the default branch looks finished,
    // which is the failure the clause exists for.
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 6' },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('main');
    expect(verdict.blocks[0]).toContain('default_branch');
    expect(verdict.blocks[0]).toContain('FR-7.1');
  });

  it('checks against the configured branch, not against a hardcoded main', () => {
    const config = { ...withTrackedDocuments('1.3'), defaultBranch: 'trunk' };
    // The repository is on main, and main is not this project's default
    // branch, so the WIP stop is allowed there.
    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 6' },
    });

    expect(verdict.allowed).toBe(true);
  });

  it('blocks a WIP stop on a detached HEAD, which is not a branch at all', () => {
    const config = withTrackedDocuments('1.3');
    git('checkout', '-q', '--detach');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 6' },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('detached');
  });

  it('allows a WIP stop on a branch whose first commit is that stop', () => {
    // A branch created to carry unfinished work has no commit on it until the
    // stop commits, so this is the ordinary shape of the WIP occasion, not an
    // edge. It was refused as a detached HEAD while the branch probe resolved
    // HEAD to a commit before naming it (FR-7.1, D-33).
    const unborn = mkdtempSync(join(tmpdir(), 'wardroom-unborn-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'wip/tour-3', unborn], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: unborn });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: unborn });
      mkdirSync(join(unborn, '.wardroom', 'run'), { recursive: true });

      const verdict = checkCommit(unborn, configFor(TRACKED_DOCS), {
        stagedPaths: [],
        occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 6' },
      });

      expect(verdict).toEqual({
        allowed: true,
        blocks: [],
        baselineSource: 'none',
        greenSource: 'not-required',
      });
    } finally {
      rmSync(unborn, { recursive: true, force: true });
    }
  });

  it('blocks a second WIP stop, because the rule allows one', () => {
    const config = withTrackedDocuments('1.3');
    git('checkout', '-q', '-b', 'wip/tour-2');
    write('src/half.ts', 'export const half = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', `${WIP_SUBJECT_PREFIX} job 6 half done, see report`);

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'wip-stop', reason: 'still not finished' },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('already a WIP stop');
  });

  it('blocks a WIP stop that does not say why the tour is stopping', () => {
    const config = withTrackedDocuments('1.3');
    git('checkout', '-q', '-b', 'wip/tour-2');

    expect(
      checkCommit(root, config, { stagedPaths: [], occasion: { kind: 'wip-stop', reason: '  ' } })
        .blocks[0],
    ).toContain('states why');
  });
});

describe('a request that is wrong in more than one way', () => {
  it('reports the document failure and the occasion failure together', () => {
    const config = withTrackedDocuments('1.3');
    write(join(TRACKED_DOCS, 'SRS.md'), srs('1.3', '## 1. Overview and scope'));

    const verdict = checkCommit(root, config, {
      stagedPaths: stagedSrs(TRACKED_DOCS),
      occasion: { kind: 'checkpoint' },
    });

    // One problem at a time is how a five minute correction becomes an
    // afternoon, which is the same reason the config loader reports all of its.
    expect(verdict.blocks).toHaveLength(2);
    expect(verdict.blocks.some((block) => block.startsWith('SRS.md'))).toBe(true);
    expect(verdict.blocks.some((block) => block.startsWith('occasion'))).toBe(true);
  });
});

describe('green is observed, not claimed (D-58)', () => {
  // Built once: withTrackedDocuments creates a commit, and a helper that
  // committed on every call would fail the second time with nothing to commit.
  let config: ProjectConfig;

  beforeEach(() => {
    config = withTrackedDocuments('1.3');
  });

  /** A runner that answers without running anything, so the suite stays fast. */
  function answering(result: VerificationResult): VerifyRunner {
    return () => result;
  }

  const green: VerificationResult = { kind: 'green', ran: ['npm run test'] };
  const failed: VerificationResult = {
    kind: 'failed',
    failure: { command: 'npm run test', exitCode: 1, output: '3 tests failed' },
    ran: ['npm run test'],
  };

  function ask(result: VerificationResult) {
    return checkCommit(
      root,
      config,
      { stagedPaths: [], occasion: boundary },
      { runVerification: answering(result) },
    );
  }

  it('denies the commit when the definition does not pass', () => {
    const verdict = ask(failed);

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toMatch(/npm run test/);
    expect(verdict.blocks.join('\n')).toMatch(/3 tests failed/);
  });

  it('allows the commit when the definition passes', () => {
    expect(ask(green).allowed).toBe(true);
  });

  it('offers a job boundary no field to claim greenness with (D-105)', () => {
    // The fabrication test, stated as an absence since D-105. The occasion
    // used to carry the session's own account of its greenness, recorded and
    // never consulted, and the test fabricated one to show the verdict did not
    // move. There is now nothing to fabricate: the request names the tour and
    // the job and says nothing about the condition, so a committing session
    // has no way to report on the check that exists to judge it, which is
    // D-55's defect one level up (FR-7.1, D-58).
    expect(Object.keys(boundary).sort()).toEqual(['jobIndex', 'kind', 'tourId']);
    expect(ask(failed).allowed).toBe(false);
    expect(ask(green).allowed).toBe(true);
  });

  it('names the run as the source, so nobody reads the denial as the claim', () => {
    expect(ask(failed).greenSource).toBe('run');
  });

  it('refuses a boundary whose project has no green definition (FR-1.5)', () => {
    const verdict = ask({
      kind: 'no-definition',
      reason: 'the project contract carries no `verify` commands',
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks.join('\n')).toMatch(/verify/);
  });

  it('does not run the definition for a WIP stop, which is not a green occasion', () => {
    // FR-7.1's second occasion is a stop with unfinished work, which is
    // exactly when the suite is expected to be red. Requiring green there
    // would forbid the commit the rule exists to make possible.
    let ran = 0;
    const verdict = checkCommit(
      root,
      config,
      { stagedPaths: [], occasion: { kind: 'wip-stop', reason: 'context running low' } },
      {
        runVerification: () => {
          ran += 1;
          return failed;
        },
      },
    );

    expect(ran).toBe(0);
    expect(verdict.greenSource).toBe('not-required');
    // The branch check is what refuses this one, not the suite.
    expect(verdict.blocks.join('\n')).not.toMatch(/npm run test/);
  });

  it('leaves the state marker untouched, whatever the run found', () => {
    // D-58: the boundary run changes no state. A failure here denies the
    // commit and means the job is not done; it is not a failed verification
    // and it does not spend the attempt budget (FR-1.3, §4.3).
    ensureRunDir(root);
    const before: StateMarker = {
      state: 'EXECUTING',
      tourId: 'tour-3-b-ii',
      jobIndex: 4,
      interruptedState: null,
      attemptCount: 2,
      gateId: null,
      disposition: null,
      headCommit: null,
      updatedAt: '2026-08-21T09:00:00.000Z',
    };
    writeMarker(root, before);

    ask(failed);

    const after = readMarker(root);
    expect(after.kind).toBe('ok');
    expect(after.kind === 'ok' && after.marker).toEqual(before);
    expect(after.kind === 'ok' && after.marker.attemptCount).toBe(2);
  });

  it('runs the project own verify list, not a list of its own', () => {
    const seen: (readonly string[])[] = [];
    checkCommit(
      root,
      { ...config, verify: ['npm run test', 'npm run lint'] },
      { stagedPaths: [], occasion: boundary },
      {
        runVerification: (_root, commands) => {
          seen.push(commands);
          return green;
        },
      },
    );

    expect(seen).toEqual([['npm run test', 'npm run lint']]);
  });
});

describe('the verdict says why green was not observed, and the two reasons differ', () => {
  it('reports `not-run` where the occasion never resolved', () => {
    // The check did not happen, which is not the same as a requirement waived.
    // Reporting the second as the first is how "no data" gets read as
    // "nothing wrong", one field inside the mechanism that exists to stop
    // exactly that.
    const config = withTrackedDocuments('1.3');
    orchestratorAt({ state: 'VERIFYING', jobIndex: null });

    const verdict = checkCommit(root, config, { stagedPaths: [] });

    expect(verdict.allowed).toBe(false);
    expect(verdict.greenSource).toBe('not-run');
  });

  it('reports `not-required` where the occasion genuinely waives it', () => {
    const config = withTrackedDocuments('1.3');
    orchestratorAt({ state: 'CLOSING', tourId: 'tour-9', jobIndex: null, disposition: 'closed' });

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'closure', tourId: 'tour-9', disposition: 'closed' },
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.greenSource).toBe('not-required');
  });

  it('reports `run` where it observed green itself', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, { stagedPaths: [], occasion: boundary });

    expect(verdict.greenSource).toBe('run');
  });

  it('reports `not-run` where the caller named an occasion the marker refuses', () => {
    const config = withTrackedDocuments('1.3');
    orchestratorAt();

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'closure', tourId: 'tour-9', disposition: 'closed' },
    });

    expect(verdict.greenSource).toBe('not-run');
  });
});
