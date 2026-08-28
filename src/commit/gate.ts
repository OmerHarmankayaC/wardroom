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
import { currentBranch, fileAtHead, headSubject, isPathCommitted } from '../state/git.js';
import {
  type StateMarker,
  TOUR_DISPOSITIONS,
  type TourDisposition,
  readMarker,
} from '../state/marker.js';
import { type VerifyRunner, runVerification } from '../verify/run.js';
import { COMMIT_OCCASIONS, WIP_SUBJECT_PREFIX } from './kinds.js';
import { deriveCommitOccasion, wipStopFromSubject } from './occasion.js';

/**
 * The commit gate (SDD §4.5). Every commit Wardroom makes passes it first.
 *
 * Two rules, checked together so a caller learns everything wrong with a
 * request at once rather than one refusal at a time:
 *
 * - **Document integrity (FR-6.1, D-16, D-30).** A canonical document in the
 *   staged set whose content differs from its baseline must also differ in
 *   version, and must carry a change-log row for that version.
 * - **The occasion (FR-7.1, D-26, D-76).** A commit is created at a job
 *   boundary, at the closure of a tour, or as a single WIP commit when
 *   stopping with unfinished work. Nothing else.
 *
 * **The occasion is verified, whoever names it (D-115).** D-105 said the
 * occasion is derived and never injected, and that could not survive the
 * gate's second caller: the orchestrator makes two of the three commits
 * itself (D-112), so it is the caller, and a caller naming nothing would leave
 * the gate deriving an occasion for a commit whose occasion the caller already
 * knows. The rule that holds for both callers is verification rather than
 * derivation. The hook names nothing and the gate derives from the marker,
 * which is D-105 unchanged for the path D-105 was about; the orchestrator
 * names its occasion and the gate checks it against the marker, refusing where
 * the two disagree.
 *
 * The WIP stop is the exception in both directions and the marker cannot
 * confirm it (D-110): nothing in the marker changes when a stop condition ends
 * a tour, so a tour stopping and a tour at a job boundary read identically
 * there. What the gate can still check it checks from the repository rather
 * than from the caller: the branch and the single-WIP rule.
 *
 * The occasion is enforced rather than instructed for the same reason FR-2.1
 * is: a rule that lives only in a role's system prompt holds until the model
 * has a plausible reason to break it, and commit granularity is exactly the
 * rule an agent talks itself out of one checkpoint at a time.
 */

// Re-exported from ./kinds.ts, which exists so that this module and its
// derivation do not import each other at runtime. This is where a reader looks
// for them, and the split is a fact about module loading rather than a second
// home for either.
export { COMMIT_OCCASIONS, type CommitOccasionKind, WIP_SUBJECT_PREFIX } from './kinds.js';

/**
 * A job done by the whole definition of done (FR-7.1).
 *
 * Two fields it used to carry, and why it carries neither (D-105).
 *
 * `acceptancePassed` was a claim with no honest source. §4.5 says in as many
 * words that no mechanism can observe a prose criterion, and nothing carried
 * the session's word for it to the gate, so the orchestrator had nothing to
 * put there: writing `true` builds a condition that can never fail, which is
 * worse than no condition at all, because it reads as a check in the code and
 * in the document. The criterion sits in T-6 with the audits.
 *
 * `verificationGreen` was the session's account of its own greenness,
 * recorded and never consulted (D-58). It was fillable only by a caller, and
 * since D-105 there is no caller: the occasion is derived from the marker
 * (./occasion.ts), and a deriver would have had to invent a value for it. What
 * the field demonstrated, that the verdict does not move with the claim, the
 * gate now states more strongly by offering nothing to claim with, and
 * `greenSource` still says where the answer came from.
 */
export interface JobBoundaryOccasion {
  readonly kind: 'job-boundary';
  readonly tourId: string;
  readonly jobIndex: number;
}

/**
 * The one commit a tour closes with (FR-7.1, D-76, SDD §4.6 step 8).
 *
 * The only occasion whose staged set may touch the document root, and the
 * commit that carries the version bumps FR-6.1 checks. Accepting the occasion
 * is not accepting the contents: the document check runs over it exactly as it
 * runs over any other staged set, which is the whole reason this commit is the
 * one that carries documents.
 */
export interface ClosureOccasion {
  readonly kind: 'closure';
  readonly tourId: string;
  /** Closed, abandoned (D-35) or carried (D-66). Three and no more (§3.2). */
  readonly disposition: TourDisposition;
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

export type CommitOccasion =
  | JobBoundaryOccasion
  | ClosureOccasion
  | WipStopOccasion
  | OtherOccasion;

export interface CommitRequest {
  /** Repository-relative paths in the staged set. */
  readonly stagedPaths: readonly string[];
  /**
   * The occasion the caller says it is committing at, or absent to let the
   * gate derive one (D-115).
   *
   * Absent is the hook's path: a session names nothing and the marker answers
   * (D-105). Present is the orchestrator's: it made the decision to close a
   * tour or to stop with unfinished work, so it says which, and the gate
   * checks the claim rather than taking it.
   */
  readonly occasion?: CommitOccasion;
  /**
   * The subject of the commit being requested, where one is known.
   *
   * The WIP stop is recognised from it (D-110), because no field of the marker
   * changes when a stop condition ends a tour. Null where the caller has no
   * subject to offer, which reads as "not a WIP stop" and never as "unknown":
   * a commit that does not announce itself as a stop is not one.
   */
  readonly subject?: string | null;
}

export interface CommitGateOptions {
  /**
   * The green definition run (§4.3). Injected so tests need not spend a real
   * suite on every case; the default is the real run, because a gate whose
   * observation is optional is a gate back to accepting the claim.
   */
  readonly runVerification?: VerifyRunner;
  /**
   * The marker to check the occasion against, where the caller already holds
   * one. Absent, the gate reads it from disk.
   *
   * Not a loophole in D-115. What that rule forbids is the occasion coming
   * from the committer, and no session ever calls this function: both callers
   * are orchestrator code, and the marker has one writer (D-47). What it buys
   * is the hook's own invariant, which is that the marker is read once at the
   * top of a call so that three decisions inside it cannot see three different
   * states. A gate that re-read would put that back.
   */
  readonly marker?: StateMarker;
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

function isClosure(occasion: CommitOccasion): occasion is ClosureOccasion {
  return occasion.kind === COMMIT_OCCASIONS[1];
}

function isWipStop(occasion: CommitOccasion): occasion is WipStopOccasion {
  return occasion.kind === COMMIT_OCCASIONS[2];
}

/** Stated from COMMIT_OCCASIONS, so the list and the refusal cannot drift apart. */
const EXPECTED = `Wardroom commits on ${COMMIT_OCCASIONS.length} occasions and no others: at a job boundary (${COMMIT_OCCASIONS[0]}), with the work green; at the closure of a tour (${COMMIT_OCCASIONS[1]}), carrying the documents, the tour log and the cleared open-tour block; or once as a WIP commit when stopping with unfinished work (${COMMIT_OCCASIONS[2]}). FR-7.1, BACKLOG D-26, D-76`;

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
    checkGreen(root, config, runner, occasion, blocks);
    return 'run';
  }

  if (isClosure(occasion)) {
    // No green run. The tour was verified before it reached CLOSING, and an
    // abandoned closure is the closure of a tour that could not go green
    // (D-35), so requiring it here would forbid the closure that disposition
    // exists for.
    //
    // That the orchestrator is in CLOSING is not checked here: this occasion
    // only exists because the marker said so, either by derivation or by
    // agreeing with what the caller named (D-115). The field the occasion used
    // to carry for it was the caller's claim about the orchestrator's own
    // state, and a claim that could refuse a commit the marker permits is a
    // second home for a fact the marker owns.
    if (!TOUR_DISPOSITIONS.includes(occasion.disposition)) {
      blocks.push(
        `occasion: ${JSON.stringify(occasion.disposition)} is not a disposition. A closure records one of ${TOUR_DISPOSITIONS.join(', ')} and no more (SDD §3.2, D-35, D-66).`,
      );
    }
    return 'not-required';
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

  const tracked = isPathCommitted(root, config.docRoot);
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
 * How one occasion differs from another, in the fields the marker can settle.
 *
 * Compared field by field rather than by deep equality, so the message names
 * what disagreed. A caller told only that two records differ reads both and
 * guesses; a caller told which field differs has the answer.
 */
function occasionDisagreement(named: CommitOccasion, derived: CommitOccasion): string | null {
  if (named.kind !== derived.kind) {
    return `the caller named ${JSON.stringify(named.kind)} and the marker says ${JSON.stringify(derived.kind)}`;
  }
  if (isJobBoundary(named) && isJobBoundary(derived)) {
    if (named.tourId !== derived.tourId) {
      return `the caller named tour ${JSON.stringify(named.tourId)} and the marker carries ${JSON.stringify(derived.tourId)}`;
    }
    if (named.jobIndex !== derived.jobIndex) {
      return `the caller named job ${named.jobIndex} and the marker carries job ${derived.jobIndex}`;
    }
  }
  if (isClosure(named) && isClosure(derived)) {
    if (named.tourId !== derived.tourId) {
      return `the caller named tour ${JSON.stringify(named.tourId)} and the marker carries ${JSON.stringify(derived.tourId)}`;
    }
    if (named.disposition !== derived.disposition) {
      return `the caller named the disposition ${JSON.stringify(named.disposition)} and the marker carries ${JSON.stringify(derived.disposition)}`;
    }
  }
  return null;
}

/**
 * The occasion this commit is actually being made on (D-105, D-115).
 *
 * The marker is read here rather than taken from the caller, because the whole
 * point is that the caller's claim is checked against something it does not
 * supply. A marker that cannot be read refuses the commit: a check that could
 * not run reported nothing, and a commit created on that silence is exactly
 * the history FR-7.1 exists to keep bisectable.
 */
function resolveOccasion(
  root: string,
  request: CommitRequest,
  supplied: StateMarker | undefined,
  blocks: string[],
): CommitOccasion | null {
  const named = request.occasion;

  // The WIP stop, before anything reads the marker. It is the one occasion the
  // marker cannot confirm (D-110), so the marker cannot refuse it either:
  // declining the commit that saves unfinished work because the record of
  // where we are is unreadable would discard work at exactly the moment things
  // have already gone wrong. What can still be checked is checked below in
  // `checkOccasion`, from `.git` rather than from the caller.
  if (named !== undefined && isWipStop(named)) return named;
  if (named === undefined) {
    const announced = wipStopFromSubject(request.subject ?? null);
    if (announced !== null) return announced;
  }

  // A kind that is not an occasion at all is a different fact from a caller at
  // the wrong moment, and the list is what a caller needs back.
  if (named !== undefined && !(COMMIT_OCCASIONS as readonly string[]).includes(named.kind)) {
    blocks.push(
      `occasion: ${JSON.stringify(named.kind)} is not an occasion to commit on. ${EXPECTED}.`,
    );
    return null;
  }

  let marker: StateMarker;
  if (supplied === undefined) {
    const read = readMarker(root);
    if (read.kind !== 'ok') {
      blocks.push(
        `occasion: the state marker is ${read.kind}, so nothing can say which occasion this commit is at (SDD §4.4 step 1, D-20).`,
      );
      return null;
    }
    marker = read.marker;
  } else {
    marker = supplied;
  }

  const derived = deriveCommitOccasion(marker, request.subject ?? null);

  if (named === undefined) {
    // The hook's path: the session names nothing and the marker answers
    // (D-105). An undecidable marker is a commit asked for from a state that
    // names no moment at all, which is a different fact from a commit asked
    // for at the wrong moment, and the reason says which.
    if (derived.kind === 'undecidable') {
      blocks.push(`occasion: ${derived.reason}`);
      return null;
    }
    return derived.occasion;
  }

  if (derived.kind === 'undecidable') {
    blocks.push(`occasion: the caller named ${JSON.stringify(named.kind)} and ${derived.reason}`);
    return null;
  }

  const disagreement = occasionDisagreement(named, derived.occasion);
  if (disagreement !== null) {
    blocks.push(
      `occasion: ${disagreement}. A caller may name its occasion and the gate checks it against the marker, which is the orchestrator's own record of where it is (SDD §4.5, D-115).`,
    );
    return null;
  }

  return named;
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
  const occasion = resolveOccasion(root, request, options.marker, blocks);

  // A refused occasion still reports the document problems found above: a
  // caller told about one problem at a time fixes one problem at a time.
  const greenSource =
    occasion === null
      ? 'not-required'
      : checkOccasion(root, config, options.runVerification ?? runVerification, occasion, blocks);

  return { allowed: blocks.length === 0, blocks, baselineSource, greenSource };
}
