import { describe, expect, it } from 'vitest';
import {
  canonicalDocuments,
  documentHash,
  documentVersion,
  hasChangeLogRow,
  versionCarryingDocuments,
} from '../../src/documents/set.js';

/**
 * What a canonical document is (SRS §3.2) and how FR-6.1 measures it. The
 * header format below is the one every canonical document in this project
 * actually uses, so the parsers are checked against the real shape rather than
 * against a convenient one.
 */

const document = [
  '# Software Requirements Specification, Wardroom',
  '',
  'Version 1.3 · 2026-08-20',
  '',
  '| Version | Date | Change |',
  '|---|---|---|',
  '| 1.2 | 2026-08-20 | §5.7 repository hygiene added |',
  '| 1.3 | 2026-08-20 | Tour 2 doc-first pass |',
  '',
  '## 1. Overview',
].join('\n');

describe('canonicalDocuments', () => {
  it('is the light set', () => {
    expect(canonicalDocuments('light')).toEqual(['PROGRESS.md', 'DECISIONS.md']);
  });

  it('is the standard set, where the decision log lives in the backlog', () => {
    expect(canonicalDocuments('standard')).toEqual(['PROGRESS.md', 'CHARTER.md', 'BACKLOG.md']);
  });

  it('is the full set, which adds the specification and the design', () => {
    expect(canonicalDocuments('full')).toEqual([
      'PROGRESS.md',
      'CHARTER.md',
      'BACKLOG.md',
      'SRS.md',
      'SDD.md',
    ]);
  });

  it('does not invent a document the level does not define', () => {
    expect(canonicalDocuments('light')).not.toContain('SRS.md');
    expect(canonicalDocuments('standard')).not.toContain('SDD.md');
  });

  it('carries PROGRESS.md at every level', () => {
    for (const level of ['light', 'standard', 'full'] as const) {
      expect(canonicalDocuments(level)).toContain('PROGRESS.md');
    }
  });
});

describe('documentVersion', () => {
  it('reads the version from the header line', () => {
    expect(documentVersion(document)).toBe('1.3');
  });

  it('reads the header rather than the first change-log row', () => {
    // The rows are older versions; reading one of them would report the
    // document as permanently behind itself.
    expect(documentVersion(document)).not.toBe('1.2');
  });

  it('is null for a document that carries no version block', () => {
    expect(documentVersion('# PROGRESS, Wardroom\n\n## Repo\n')).toBeNull();
  });

  it('reads a version whose date suffix uses the separator the documents use', () => {
    expect(documentVersion('Version 2.0 · 2026-09-01\n')).toBe('2.0');
  });

  it('ignores a version line that is not at the start of a line', () => {
    expect(documentVersion('see Version 9.9 elsewhere\n')).toBeNull();
  });
});

describe('hasChangeLogRow', () => {
  it('finds the row for the current version', () => {
    expect(hasChangeLogRow(document, '1.3')).toBe(true);
  });

  it('finds a row for an earlier version too', () => {
    expect(hasChangeLogRow(document, '1.2')).toBe(true);
  });

  it('misses a version the table does not carry', () => {
    expect(hasChangeLogRow(document, '1.4')).toBe(false);
  });

  it('does not match a version mentioned in prose outside the table', () => {
    const prose = `${document}\n\nThis supersedes 1.4 in spirit.\n`;

    expect(hasChangeLogRow(prose, '1.4')).toBe(false);
  });

  it('treats the version as text, not as a pattern', () => {
    expect(hasChangeLogRow(document, '1x3')).toBe(false);
  });
});

describe('documentHash', () => {
  it('is stable for identical content', () => {
    expect(documentHash(document)).toBe(documentHash(document));
  });

  it('moves for a one-character change', () => {
    expect(documentHash(document)).not.toBe(documentHash(`${document} `));
  });

  it('moves for a change that leaves the version alone', () => {
    // The whole reason the baseline carries a hash (BACKLOG D-30).
    const edited = document.replace('## 1. Overview', '## 1. Overview and scope');

    expect(documentVersion(edited)).toBe(documentVersion(document));
    expect(documentHash(edited)).not.toBe(documentHash(document));
  });
});

describe('versionCarryingDocuments (BACKLOG D-31)', () => {
  it('is the specification class, and PROGRESS is not in it', () => {
    expect(versionCarryingDocuments('full')).toEqual([
      'CHARTER.md',
      'BACKLOG.md',
      'SRS.md',
      'SDD.md',
    ]);
  });

  it('is the decision log at the light level, where there is no charter', () => {
    expect(versionCarryingDocuments('light')).toEqual(['DECISIONS.md']);
  });

  it('is the charter and the backlog at the standard level', () => {
    expect(versionCarryingDocuments('standard')).toEqual(['CHARTER.md', 'BACKLOG.md']);
  });

  it('never carries PROGRESS.md, at any level', () => {
    // FR-6.1 read literally blocks every commit that touches PROGRESS: a
    // document with no version cannot have one that differs from its
    // baseline, so the condition can never be satisfied (D-31).
    for (const level of ['light', 'standard', 'full'] as const) {
      expect(versionCarryingDocuments(level)).not.toContain('PROGRESS.md');
    }
  });

  it('is a subset of the level canonical set, so the two cannot drift', () => {
    for (const level of ['light', 'standard', 'full'] as const) {
      const canonical = canonicalDocuments(level);
      for (const name of versionCarryingDocuments(level)) {
        expect(canonical).toContain(name);
      }
    }
  });

  it('is read from the level, never from the contents of a document', () => {
    // The mutation this test exists for: inferring the set from whether a
    // version block is present makes the rule switchable by editing the file
    // it governs, so deleting the block from SRS.md would exempt SRS.md.
    expect(versionCarryingDocuments('full')).toContain('SRS.md');
    expect(versionCarryingDocuments('full').length).toBeLessThan(canonicalDocuments('full').length);
  });
});
