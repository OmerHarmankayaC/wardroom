import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import type { ProjectConfig } from '../../src/config/schema.js';
import {
  buildDocBaseline,
  readDocBaseline,
  recordClosureBaseline,
  writeDocBaseline,
} from '../../src/documents/baseline.js';
import {
  canonicalDocuments,
  documentHash,
  versionCarryingDocuments,
} from '../../src/documents/set.js';

/**
 * The closure baseline (SRS §3.3, BACKLOG D-30). It exists because a project
 * whose document root is untracked has no git copy to compare against, and a
 * version alone cannot serve as a baseline.
 */

let root: string;

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: 'internal/docs',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['npm test'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 3,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

function versioned(name: string, version: string): string {
  return [
    `# ${name}`,
    '',
    `Version ${version} · 2026-08-20`,
    '',
    '| Version | Date | Change |',
    '|---|---|---|',
    `| ${version} | 2026-08-20 | a change |`,
    '',
  ].join('\n');
}

function writeDocument(name: string, contents: string): void {
  const target = join(root, config.docRoot, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-baseline-'));
  mkdirSync(wardroomPaths(root).runDir, { recursive: true });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildDocBaseline', () => {
  it('records a version and a hash for each canonical document present', () => {
    writeDocument('SRS.md', versioned('SRS', '1.3'));
    writeDocument('SDD.md', versioned('SDD', '1.4'));

    const baseline = buildDocBaseline(root, config);

    expect(baseline['SRS.md']).toEqual({
      version: '1.3',
      hash: documentHash(versioned('SRS', '1.3')),
    });
    expect(baseline['SDD.md']?.version).toBe('1.4');
  });

  it('leaves PROGRESS out of the record entirely (BACKLOG D-31)', () => {
    writeDocument('PROGRESS.md', '# PROGRESS\n\n## Repo\n');
    writeDocument('SRS.md', versioned('SRS', '1.3'));

    const baseline = buildDocBaseline(root, config);

    // The record covers the version-carrying set and nothing else. Hashing
    // PROGRESS would record a baseline for a document FR-6.1's version rule
    // cannot reach, which is a fact stored for no reader.
    expect(baseline['PROGRESS.md']).toBeUndefined();
    expect(Object.keys(baseline)).toEqual(['SRS.md']);
  });

  it('records a null version for a version-carrying document that lost its block', () => {
    // Not an exemption. The record says the document carried no version at the
    // last close, and the commit gate blocks the next content change on it.
    writeDocument('SDD.md', '# SDD\n\n## 1. Architecture\n');

    expect(buildDocBaseline(root, config)['SDD.md']).toEqual({
      version: null,
      hash: documentHash('# SDD\n\n## 1. Architecture\n'),
    });
  });

  it('omits a document the level defines but the project has not written', () => {
    writeDocument('SRS.md', versioned('SRS', '1.3'));

    const baseline = buildDocBaseline(root, config);

    // An empty record would claim the document was blank at the last close,
    // which would make its first real content look like an unbumped edit.
    expect(Object.keys(baseline)).toEqual(['SRS.md']);
  });

  it('records only what the level defines', () => {
    writeDocument('SRS.md', versioned('SRS', '1.3'));
    writeDocument('NOTES.md', versioned('NOTES', '1.0'));

    expect(Object.keys(buildDocBaseline(root, config))).toEqual(['SRS.md']);
  });

  it('holds exactly the version-carrying set when every document is present', () => {
    for (const name of canonicalDocuments(config.level)) {
      writeDocument(name, versioned(name, '1.0'));
    }

    expect(Object.keys(buildDocBaseline(root, config)).sort()).toEqual(
      [...versionCarryingDocuments(config.level)].sort(),
    );
  });
});

describe('writeDocBaseline and readDocBaseline', () => {
  it('is null before any tour has closed', () => {
    expect(readDocBaseline(root)).toBeNull();
  });

  it('round-trips through the file the design names', () => {
    writeDocument('SRS.md', versioned('SRS', '1.3'));
    const baseline = buildDocBaseline(root, config);

    writeDocBaseline(root, baseline);

    expect(readDocBaseline(root)).toEqual(baseline);
    expect(readFileSync(wardroomPaths(root).docBaselineFile, 'utf8')).toContain('SRS.md');
  });

  it('lives with the runtime records, not beside the project contract', () => {
    expect(wardroomPaths(root).docBaselineFile).toBe(
      join(root, '.wardroom', 'run', 'doc-baseline.json'),
    );
  });
});

describe('recordClosureBaseline', () => {
  it('writes the baseline where the document root is untracked', () => {
    writeDocument('SRS.md', versioned('SRS', '1.3'));

    const result = recordClosureBaseline(root, config);

    expect(result.written).toBe(true);
    expect(readDocBaseline(root)?.['SRS.md']?.version).toBe('1.3');
  });

  it('writes nothing where git already holds the documents', () => {
    writeDocument('SRS.md', versioned('SRS', '1.3'));
    git('add', '-A');
    git('commit', '-q', '-m', 'add documents');

    const result = recordClosureBaseline(root, config);

    // A second copy of content git already carries would be a second home for
    // one fact, and two homes are two answers the first time they drift.
    expect(result.written).toBe(false);
    expect(readDocBaseline(root)).toBeNull();
  });
});
