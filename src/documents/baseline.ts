import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wardroomPaths } from '../config/paths.js';
import type { ProjectConfig } from '../config/schema.js';
import { atomicWriteFile } from '../fs/atomic.js';
import { isPathTracked } from '../state/git.js';
import { documentHash, documentVersion, versionCarryingDocuments } from './set.js';

/**
 * The document baseline written at tour closure (SRS §3.3, SDD §3.0,
 * BACKLOG D-30): per version-carrying canonical document (SRS §3.2, D-31),
 * its version and a hash of its content.
 *
 * It exists for one case. Where the document root is untracked (D-8, and this
 * repository is that case) git has no copy to compare against, and FR-6.1 as
 * originally written resolved to "the version recorded at the last tour
 * close", which cannot detect anything: the only version available to compare
 * that record against is the version inside the document being checked, so an
 * edit that moved the content and left the version alone compares equal and
 * passes. The check would still run and still report clean, which makes the
 * failure invisible rather than merely possible.
 *
 * It is a derived record, rebuildable from the documents at any closed
 * boundary, which is why it sits under `run/` rather than beside
 * `config.json`. Where the document root IS tracked it is neither written nor
 * read: git already holds the content, and a second copy of it would be a
 * second home for one fact.
 */

export interface BaselineRecord {
  /**
   * Null where the document carried no version block at the last close. The
   * record says so rather than omitting the document, because a
   * version-carrying document without a version is a defect the commit gate
   * must be able to see, not one it should read as an exemption.
   */
  readonly version: string | null;
  readonly hash: string;
}

export type DocBaseline = Readonly<Record<string, BaselineRecord>>;

/**
 * Reads the version-carrying documents that are present and records what they
 * say now. PROGRESS and the tour logs are canonical and are not in the record:
 * FR-6.1's version rule cannot reach them, so a baseline for them would be a
 * fact stored for no reader (D-31).
 */
export function buildDocBaseline(root: string, config: ProjectConfig): DocBaseline {
  const baseline: Record<string, BaselineRecord> = {};

  for (const name of versionCarryingDocuments(config.level)) {
    let contents: string;
    try {
      contents = readFileSync(join(root, config.docRoot, name), 'utf8');
    } catch {
      // A document the level defines but the project has not written yet is
      // omitted rather than recorded as empty. An empty record would be a
      // baseline claiming the document was blank at the last close, which
      // would make its first real content look like an unbumped edit.
      continue;
    }
    baseline[name] = { version: documentVersion(contents), hash: documentHash(contents) };
  }

  return baseline;
}

export function writeDocBaseline(root: string, baseline: DocBaseline): void {
  atomicWriteFile(wardroomPaths(root).docBaselineFile, `${JSON.stringify(baseline, null, 2)}\n`);
}

/** The recorded baseline, or null where no tour has closed yet. */
export function readDocBaseline(root: string): DocBaseline | null {
  let text: string;
  try {
    text = readFileSync(wardroomPaths(root).docBaselineFile, 'utf8');
  } catch {
    return null;
  }
  return JSON.parse(text) as DocBaseline;
}

/**
 * What tour closure calls. Writes the baseline only where git cannot supply
 * one, and reports which it did so a caller does not have to re-derive it.
 */
export function recordClosureBaseline(
  root: string,
  config: ProjectConfig,
): { readonly written: boolean; readonly baseline: DocBaseline | null } {
  if (isPathTracked(root, config.docRoot)) {
    return { written: false, baseline: null };
  }
  const baseline = buildDocBaseline(root, config);
  writeDocBaseline(root, baseline);
  return { written: true, baseline };
}
