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
 * Where the tour logs live, relative to the document root: `<doc_root>/tours/`
 * (SRS §3.2). Every level produces them, so the name does not depend on the
 * level and takes no argument to say so.
 */
export function tourLogDirectory(): string {
  return 'tours';
}

/**
 * Which canonical documents carry a version and a change log (SRS §3.2,
 * BACKLOG D-31). The specification class does; PROGRESS and the tour logs do
 * not, and FR-6.1's version rule reaches the first list and nothing else.
 *
 * This is a stated property of the document, never inferred from whether a
 * version block happens to be present in the file. A rule whose reach is read
 * out of the file being checked can be switched off by editing that file:
 * under the inference this replaces, deleting the version block from SRS.md
 * exempted SRS.md.
 */
const VERSION_CARRYING_NAMES: readonly string[] = [
  'CHARTER.md',
  'BACKLOG.md',
  'SRS.md',
  'SDD.md',
  'DECISIONS.md',
];

/**
 * The version-carrying documents of a project at this level.
 *
 * Derived from {@link canonicalDocuments} rather than listed again per level,
 * so the per-level set has one home and the version-carrying property has one
 * home, and the second can never name a document the first does not define.
 */
export function versionCarryingDocuments(level: ProjectLevel): readonly string[] {
  return canonicalDocuments(level).filter((name) => VERSION_CARRYING_NAMES.includes(name));
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
 * Null where the document carries no version block. That is not an exemption:
 * whether the version rule reaches a document is answered by
 * {@link versionCarryingDocuments} from the project's level, so a document in
 * that set which carries no version block is in breach rather than outside the
 * rule. PROGRESS is the ordinary null case and is outside the set entirely.
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
