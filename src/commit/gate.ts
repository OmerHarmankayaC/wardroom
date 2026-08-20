import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import { type BaselineRecord, readDocBaseline } from '../documents/baseline.js';
import {
  canonicalDocuments,
  documentHash,
  documentVersion,
  hasChangeLogRow,
} from '../documents/set.js';
import { fileAtHead, headSubject, isPathTracked } from '../state/git.js';

/**
 * The commit gate (SDD §4.5). Every commit Wardroom makes passes it first.
 *
 * Two rules, checked together so a caller learns everything wrong with a
 * request at once rather than one refusal at a time:
 *
 * - **Document integrity (FR-6.1, D-16, D-30).** A canonical document in the
 *   staged set whose content differs from its baseline must also differ in
 *   version, and must carry a change-log row for that version.
 * - **The occasion (FR-7.1, D-26).** A commit is created at a job boundary or
 *   as a single WIP commit when stopping with unfinished work. Nothing else.
 *
 * The occasion is enforced rather than instructed for the same reason FR-2.1
 * is: a rule that lives only in a role's system prompt holds until the model
 * has a plausible reason to break it, and commit granularity is exactly the
 * rule an agent talks itself out of one checkpoint at a time.
 */

/**
 * The two occasions FR-7.1 allows. The whole list: there is no periodic
 * autosave commit, no per file commit, and no squash step later, because
 * squashing would rewrite history, which is the owner's operation and never
 * Wardroom's (SDD §4.5).
 */
export const COMMIT_OCCASIONS = ['job-boundary', 'wip-stop'] as const;
export type CommitOccasionKind = (typeof COMMIT_OCCASIONS)[number];

/** How a WIP stop announces itself in the log, so a second one can be seen. */
export const WIP_SUBJECT_PREFIX = 'WIP:';

export interface JobBoundaryOccasion {
  readonly kind: 'job-boundary';
  readonly tourId: string;
  readonly jobIndex: number;
  /** The job's acceptance criterion passed. */
  readonly acceptancePassed: boolean;
  /** Every command in the green definition exited zero (SRS §3.4). */
  readonly verificationGreen: boolean;
}

export interface WipStopOccasion {
  readonly kind: 'wip-stop';
  /** Why the tour is stopping with work unfinished, for the commit message. */
  readonly reason: string;
}

/** Anything else a caller might ask for, so the gate can refuse it by name. */
export interface OtherOccasion {
  readonly kind: string;
}

export type CommitOccasion = JobBoundaryOccasion | WipStopOccasion | OtherOccasion;

export interface CommitRequest {
  /** Repository-relative paths in the staged set. */
  readonly stagedPaths: readonly string[];
  readonly occasion: CommitOccasion;
}

export interface CommitVerdict {
  readonly allowed: boolean;
  /** One stated reason per failed condition. Empty when the commit may proceed. */
  readonly blocks: readonly string[];
  /**
   * Which baseline the document check actually used.
   *
   * `no-baseline` is distinct from `doc-baseline.json` on purpose: a check
   * that had no record to compare against is not the same answer as a check
   * that compared and found nothing wrong, and reporting them as one is how
   * "no data" gets read as "zero".
   */
  readonly baselineSource: 'head' | 'doc-baseline.json' | 'no-baseline' | 'none';
}

function isJobBoundary(occasion: CommitOccasion): occasion is JobBoundaryOccasion {
  return occasion.kind === COMMIT_OCCASIONS[0];
}

function isWipStop(occasion: CommitOccasion): occasion is WipStopOccasion {
  return occasion.kind === COMMIT_OCCASIONS[1];
}

/** Stated from COMMIT_OCCASIONS, so the list and the refusal cannot drift apart. */
const EXPECTED = `Wardroom commits on ${COMMIT_OCCASIONS.length} occasions and no others: at a job boundary (${COMMIT_OCCASIONS[0]}), with the acceptance criterion passed and the work green, or once as a WIP commit when stopping with unfinished work (${COMMIT_OCCASIONS[1]}). FR-7.1, BACKLOG D-26`;

function checkOccasion(root: string, occasion: CommitOccasion, blocks: string[]): void {
  if (isJobBoundary(occasion)) {
    if (!occasion.acceptancePassed) {
      blocks.push(
        `occasion: job ${occasion.jobIndex} of ${occasion.tourId} has not passed its acceptance criterion, so this is not a job boundary. ${EXPECTED}.`,
      );
    }
    if (!occasion.verificationGreen) {
      blocks.push(
        `occasion: job ${occasion.jobIndex} of ${occasion.tourId} is not green, so this is not a job boundary. ${EXPECTED}.`,
      );
    }
    return;
  }

  if (isWipStop(occasion)) {
    if (occasion.reason.trim() === '') {
      blocks.push('occasion: a WIP stop states why the tour is stopping with work unfinished.');
    }
    const subject = headSubject(root);
    if (subject !== null && subject.startsWith(WIP_SUBJECT_PREFIX)) {
      // FR-7.1 permits ONE WIP commit. A second turns the escape hatch into
      // the periodic checkpoint commit the rule exists to forbid.
      blocks.push(
        `occasion: HEAD is already a WIP stop (${JSON.stringify(subject)}). A stop with unfinished work produces one WIP commit, not a series. ${EXPECTED}.`,
      );
    }
    return;
  }

  blocks.push(
    `occasion: ${JSON.stringify(occasion.kind)} is not an occasion to commit on. ${EXPECTED}.`,
  );
}

/** The baseline for one document, and where it came from. */
function baselineFor(
  root: string,
  path: string,
  name: string,
  tracked: boolean,
  recorded: Readonly<Record<string, BaselineRecord>> | null,
): BaselineRecord | null {
  if (tracked) {
    const committed = fileAtHead(root, path);
    return committed === null
      ? null
      : { version: documentVersion(committed), hash: documentHash(committed) };
  }
  return recorded?.[name] ?? null;
}

function checkDocuments(
  root: string,
  config: ProjectConfig,
  stagedPaths: readonly string[],
  blocks: string[],
): CommitVerdict['baselineSource'] {
  const staged = new Set(stagedPaths);
  const documents = canonicalDocuments(config.level)
    .map((name) => ({ name, path: join(config.docRoot, name) }))
    .filter((document) => staged.has(document.path));

  if (documents.length === 0) return 'none';

  const tracked = isPathTracked(root, config.docRoot);
  const recorded = tracked ? null : readDocBaseline(root);

  for (const { name, path } of documents) {
    let contents: string;
    try {
      contents = readFileSync(join(root, path), 'utf8');
    } catch {
      // Staged but unreadable is a deletion or a rename, neither of which the
      // version rule speaks to. The commit is not blocked on a document that
      // is not there to have a version.
      continue;
    }

    const baseline = baselineFor(root, path, name, tracked, recorded);
    // A document with no baseline is new: there is nothing for its content to
    // differ from, so nothing for its version to have to differ from either.
    if (baseline === null) continue;
    if (baseline.hash === documentHash(contents)) continue;

    const version = documentVersion(contents);
    if (version === null) {
      // PROGRESS.md at every level. It is the state carrier, rewritten at
      // every job boundary, and carries neither a version nor a change log by
      // design (SRS §3.2, §3.5). An absent version can never differ from an
      // absent version, so applying the rule here would block every commit
      // that touches it, forever. Recorded as a document debt: FR-6.1 does not
      // say which canonical documents carry versions.
      continue;
    }

    if (version === baseline.version) {
      blocks.push(
        `${name}: content changed but the version is still ${version}. A document whose content moved and whose version did not is the silent divergence FR-6.1 exists to catch (baseline: ${tracked ? 'HEAD' : 'doc-baseline.json'}).`,
      );
      continue;
    }

    if (!hasChangeLogRow(contents, version)) {
      blocks.push(
        `${name}: version ${version} has no change-log row. A version bump nobody can read is the same failure as no change log at all (FR-6.1).`,
      );
    }
  }

  if (tracked) return 'head';
  return recorded === null ? 'no-baseline' : 'doc-baseline.json';
}

/**
 * Decides whether this commit may be created. Reports every failed condition,
 * because a caller told about one problem at a time fixes one problem at a
 * time.
 */
export function checkCommit(
  root: string,
  config: ProjectConfig,
  request: CommitRequest,
): CommitVerdict {
  const blocks: string[] = [];
  const baselineSource = checkDocuments(root, config, request.stagedPaths, blocks);
  checkOccasion(root, request.occasion, blocks);

  return { allowed: blocks.length === 0, blocks, baselineSource };
}
