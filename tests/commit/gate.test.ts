import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CommitOccasion, WIP_SUBJECT_PREFIX, checkCommit } from '../../src/commit/gate.js';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import { recordClosureBaseline } from '../../src/documents/baseline.js';

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
    stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
    verify: ['npm test'],
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

const boundary: CommitOccasion = {
  kind: 'job-boundary',
  tourId: 'tour-2',
  jobIndex: 6,
  acceptancePassed: true,
  verificationGreen: true,
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-commit-'));
  mkdirSync(wardroomPaths(root).runDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write('README.md', '# example\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'initial commit');
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

    expect(verdict).toEqual({ allowed: true, blocks: [], baselineSource: 'head' });
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
    ).toEqual({ allowed: true, blocks: [], baselineSource: 'doc-baseline.json' });
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
    // from has nothing for its version to have to differ from either.
    expect(verdict).toEqual({ allowed: true, blocks: [], baselineSource: 'doc-baseline.json' });
  });

  it('does not apply the version rule to a document that carries no version', () => {
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

    // PROGRESS.md is canonical at every level and has neither a version nor a
    // change log by design. An absent version can never differ from an absent
    // version, so the rule would block every commit touching it, forever.
    expect(verdict.allowed).toBe(true);
  });
});

describe('the occasion (FR-7.1)', () => {
  it('allows a job boundary that passed and is green', () => {
    const config = withTrackedDocuments('1.3');

    expect(checkCommit(root, config, { stagedPaths: [], occasion: boundary }).allowed).toBe(true);
  });

  it('blocks a job boundary whose acceptance criterion has not passed', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { ...boundary, acceptancePassed: false },
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.blocks[0]).toContain('acceptance criterion');
  });

  it('blocks a job boundary that is not green', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { ...boundary, verificationGreen: false },
    });

    expect(verdict.blocks[0]).toContain('not green');
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

  it('allows a WIP stop when HEAD is an ordinary commit', () => {
    const config = withTrackedDocuments('1.3');

    const verdict = checkCommit(root, config, {
      stagedPaths: [],
      occasion: { kind: 'wip-stop', reason: 'context ceiling reached mid job 6' },
    });

    expect(verdict.allowed).toBe(true);
  });

  it('blocks a second WIP stop, because the rule allows one', () => {
    const config = withTrackedDocuments('1.3');
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
