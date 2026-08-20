import { createHash } from 'node:crypto';
import type { ProjectLevel } from '../config/schema.js';

/**
 * What a canonical document is (SRS §3.2) and how its integrity is measured
 * (SRS §5.6, FR-6.1).
 */

/**
 * The document set is fixed per level: Wardroom neither invents documents a
 * level does not define nor omits documents it does (SRS §3.2).
 */
const SETS: Record<ProjectLevel, readonly string[]> = {
  light: ['PROGRESS.md', 'DECISIONS.md'],
  standard: ['PROGRESS.md', 'CHARTER.md', 'BACKLOG.md'],
  full: ['PROGRESS.md', 'CHARTER.md', 'BACKLOG.md', 'SRS.md', 'SDD.md'],
};

export function canonicalDocuments(level: ProjectLevel): readonly string[] {
  return SETS[level];
}

/**
 * The content hash FR-6.1 compares (BACKLOG D-30). A version alone cannot
 * serve as a baseline: the only version available to compare a recorded one
 * against is the version written inside the document being checked, so every
 * unbumped change would compare equal and pass.
 */
export function documentHash(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

/**
 * The version from the document's header line, `Version 1.3 · 2026-08-20`.
 *
 * Null where the document carries no version block. PROGRESS.md is that case
 * at every level: it is the cross-session state carrier, rewritten at every
 * job boundary, and the dev-protocol template gives it neither a version nor a
 * change log. A document with no version is outside the version rule rather
 * than permanently in breach of it, since an absent version can never differ
 * from an absent version. See the commit gate for what that means in practice.
 */
export function documentVersion(contents: string): string | null {
  const match = /^Version\s+(\S+)/m.exec(contents);
  return match === null ? null : (match[1] as string);
}

/**
 * Whether the change-log table carries a row for this version. The table's
 * first cell is the version, which is the shape every canonical document in
 * this project uses.
 */
export function hasChangeLogRow(contents: string, version: string): boolean {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\|\\s*${escaped}\\s*\\|`, 'm').test(contents);
}
