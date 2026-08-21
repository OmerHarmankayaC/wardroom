import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import { type BaselineRecord, readDocBaseline } from '../documents/baseline.js';
import {
  documentHash,
  documentVersion,
  hasChangeLogRow,
  versionCarryingDocuments,
} from '../documents/set.js';
import { currentBranch, fileAtHead, headSubject, isPathTracked } from '../state/git.js';
import { type VerifyRunner, runVerification } from '../verify/run.js';

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
  /**
   * The job's acceptance criterion passed.
   *
   * This one is claimed and cannot be otherwise: an acceptance criterion is
   * prose and nothing in a staged set reveals whether it holds. It sits beside
   * the audit in T-6 as a condition of a boundary that no gate can observe.
   */
  readonly acceptancePassed: boolean;
  /**
   * The session's own account of its greenness. Recorded and NOT consulted
   * (D-58): the gate runs the green definition itself, because a check that
   * accepts its subject's word for the condition it exists to enforce is
   * D-55's defect one level up. The field stays so that a session which claims
   * green can be seen to have claimed it, and so a test can fabricate one and
   * show the verdict does not move.
   */
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

export interface CommitGateOptions {
  /**
   * The green definition run (§4.3). Injected so tests need not spend a real
   * suite on every case; the default is the real run, because a gate whose
   * observation is optional is a gate back to accepting the claim.
   */
  readonly runVerification?: VerifyRunner;
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
  /**
   * Where the green status came from. `run` is the only value that can satisfy
   * a job boundary; `not-required` is the WIP stop, which is a stop with
   * unfinished work and is exactly when the suite is expected to be red.
   *
   * Stated in the verdict so a reader never has to infer whether the gate
   * observed green or was told it, which is the distinction D-58 exists to
   * make and the one a boolean in the request cannot carry.
   */
  readonly greenSource: 'run' | 'not-required';
}

function isJobBoundary(occasion: CommitOccasion): occasion is JobBoundaryOccasion {
  return occasion.kind === COMMIT_OCCASIONS[0];
}

function isWipStop(occasion: CommitOccasion): occasion is WipStopOccasion {
  return occasion.kind === COMMIT_OCCASIONS[1];
}

/** Stated from COMMIT_OCCASIONS, so the list and the refusal cannot drift apart. */
const EXPECTED = `Wardroom commits on ${COMMIT_OCCASIONS.length} occasions and no others: at a job boundary (${COMMIT_OCCASIONS[0]}), with the acceptance criterion passed and the work green, or once as a WIP commit when stopping with unfinished work (${COMMIT_OCCASIONS[1]}). FR-7.1, BACKLOG D-26`;

/**
 * FR-7.1's second occasion is a single WIP commit on a branch other than
 * `default_branch` (SRS §3.1, BACKLOG D-33, B-12). Unfinished work on the
 * default branch looks finished, which is the failure the clause exists for.
 */
function checkWipBranch(root: string, defaultBranch: string, blocks: string[]): void {
  const branch = currentBranch(root);
  if (branch === null) {
    blocks.push(
      'occasion: HEAD is detached. A WIP stop commits on a branch other than default_branch, and a detached HEAD is not a branch at all (FR-7.1).',
    );
    return;
  }
  if (branch === defaultBranch) {
    blocks.push(
      `occasion: the current branch is ${branch}, which is this project's default_branch. A WIP stop commits on a branch other than that one, so unfinished work never sits on ${branch} looking finished (FR-7.1, BACKLOG D-33).`,
    );
  }
}

/**
 * Runs the green definition for a job boundary and reports what it found
 * (§4.3, §4.5, D-58).
 *
 * The run changes no state. A failure here denies the commit, leaves
 * `attempt_count` untouched and means the job is not done; it is not a failed
 * verification and does not spend the attempt budget. That is the whole of the
 * separation between this run and the one `VERIFYING` makes over the tour.
 */
function checkGreen(
  root: string,
  config: ProjectConfig,
  runner: VerifyRunner,
  occasion: JobBoundaryOccasion,
  blocks: string[],
): void {
  const result = runner(root, config.verify);
  if (result.kind === 'green') return;

  if (result.kind === 'no-definition') {
    blocks.push(
      `green: job ${occasion.jobIndex} of ${occasion.tourId} cannot be shown green because ${result.reason}`,
    );
    return;
  }

  blocks.push(
    `green: job ${occasion.jobIndex} of ${occasion.tourId} is not green. \`${result.failure.command}\` exited ${result.failure.exitCode}. This is the green definition run by the gate, not the session's report of it (D-58):\n${result.failure.output.trim()}`,
  );
}

function checkOccasion(
  root: string,
  config: ProjectConfig,
  runner: VerifyRunner,
  occasion: CommitOccasion,
  blocks: string[],
): CommitVerdict['greenSource'] {
  if (isJobBoundary(occasion)) {
    if (!occasion.acceptancePassed) {
      blocks.push(
        `occasion: job ${occasion.jobIndex} of ${occasion.tourId} has not passed its acceptance criterion, so this is not a job boundary. ${EXPECTED}.`,
      );
    }
    checkGreen(root, config, runner, occasion, blocks);
    return 'run';
  }

  if (isWipStop(occasion)) {
    if (occasion.reason.trim() === '') {
      blocks.push('occasion: a WIP stop states why the tour is stopping with work unfinished.');
    }
    checkWipBranch(root, config.defaultBranch, blocks);
    const subject = headSubject(root);
    if (subject?.startsWith(WIP_SUBJECT_PREFIX)) {
      // FR-7.1 permits ONE WIP commit. A second turns the escape hatch into
      // the periodic checkpoint commit the rule exists to forbid.
      blocks.push(
        `occasion: HEAD is already a WIP stop (${JSON.stringify(subject)}). A stop with unfinished work produces one WIP commit, not a series. ${EXPECTED}.`,
      );
    }
    return 'not-required';
  }

  blocks.push(
    `occasion: ${JSON.stringify(occasion.kind)} is not an occasion to commit on. ${EXPECTED}.`,
  );
  return 'not-required';
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
  // The set comes from the project's level (SRS §3.2, BACKLOG D-31), never
  // from whether a staged file happens to hold a version block. PROGRESS and
  // the tour logs are canonical and are simply not in it: they carry no
  // version, so the rule could never be satisfied and every commit touching
  // them would block, permanently.
  const documents = versionCarryingDocuments(config.level)
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
      // Staged and no longer on disk: the staged set deletes this document, or
      // renames it away, which comes to the same thing for the path the level
      // names (D-40).
      //
      // Blocked, not skipped. A deleted file has no version and no content to
      // compare, so the comparison has nothing to run on: skipping made the
      // check report clean, which meant the one edit that removes a canonical
      // document entirely was the one edit it let past. The document set is
      // fixed by the project's level (SRS §3.2), so a deletion either
      // contradicts the contract or follows a level change, and a level change
      // is a scope change with its own gate.
      blocks.push(
        `${name}: the staged set deletes it. It is version-carrying at the ${config.level} level (SRS §3.2), which fixes the document set, so removing it either contradicts the contract or follows a level change, and a level change is a scope change with its own gate (FR-6.1, D-40).`,
      );
      continue;
    }

    const baseline = baselineFor(root, path, name, tracked, recorded);
    // A document with no baseline is new: there is nothing for its content to
    // differ from, so nothing for its version to have to differ from either.
    if (baseline === null) continue;
    if (baseline.hash === documentHash(contents)) continue;

    const version = documentVersion(contents);
    if (version === null) {
      // A document the level puts in the version-carrying set, whose version
      // block is gone. Blocked, not exempted: an enforcement that a document
      // can switch off by deleting the thing being checked is not an
      // enforcement (D-31).
      blocks.push(
        `${name}: content changed and the document carries no version block. It is version-carrying at the ${config.level} level (SRS §3.2), and the set is read from the level, not from the file.`,
      );
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
  options: CommitGateOptions = {},
): CommitVerdict {
  const blocks: string[] = [];
  const baselineSource = checkDocuments(root, config, request.stagedPaths, blocks);
  const greenSource = checkOccasion(
    root,
    config,
    options.runVerification ?? runVerification,
    request.occasion,
    blocks,
  );

  return { allowed: blocks.length === 0, blocks, baselineSource, greenSource };
}
