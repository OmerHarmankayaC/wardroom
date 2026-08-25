import type { ProjectConfig } from '../config/schema.js';
import { type OpenTourBlock, type TourJob, readOpenTour } from '../progress/open-tour.js';
import { advance } from '../state/machine.js';
import type { StateMarker, TourDisposition } from '../state/marker.js';
import { type CeilingVerdict, ceilingVerdict } from './ceiling.js';
import { assertDrivenState } from './state-guard.js';

/**
 * The `EXECUTING` drive (SDD §4.2, §3.2).
 *
 * The loop reads the job list from the open-tour block on disk, hands each job
 * to the Implementer session, and writes the marker at each boundary. It does
 * three things and refuses the rest.
 *
 * It does not implement: the session writes the code. It does not update the
 * job statuses: that is FR-2.1's one exception and belongs to the Implementer,
 * and D-65 puts the update in the same staged set as the commit, which a drive
 * writing it separately would break. It does not commit: the session creates
 * its own commits through `Bash`, held by the hook that runs the commit gate
 * (D-57).
 *
 * What it owns is the marker, because D-47 gives the marker one writer and
 * that writer is the orchestrator.
 *
 * Out of scope by the tour's own boundary: `PLANNING` before it, `VERIFYING`
 * after it, the `FAILED` path, closure, and the usage ceiling that would end a
 * tour carried at one of these boundaries (D-66, FR-1.4).
 */

/**
 * The Implementer session, as this loop needs it.
 *
 * Injected rather than constructed here because a session is a live SDK query
 * against an account, and a loop that built its own could not be exercised
 * without one. The orchestrator builds it from the role factory and the hook.
 */
export interface ImplementerSession {
  /**
   * Implements one job: the work, the test, the acceptance check, the status
   * update and the commit, in the order §4.2 fixes.
   */
  readonly runJob: (job: TourJob, index: number) => Promise<void>;
  /**
   * Whether this job's acceptance criterion passes now.
   *
   * Asked of the session because a criterion is prose and nothing else can
   * read it. §4.4 step 4 resumes at the first job whose criterion does not
   * pass, not at `job_index`: the criterion is the evidence and the index is a
   * record. The recorded status is not evidence either, for the reason D-65
   * names, so it is not consulted here at all.
   */
  readonly acceptancePasses: (job: TourJob, index: number) => Promise<boolean>;
}

export interface DriveExecutingInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as resumption left it. Must read `EXECUTING`. */
  readonly marker: StateMarker;
  readonly session: ImplementerSession;
  /**
   * Whether the run has been asked to stop, asked once at each job boundary
   * (D-83).
   *
   * A cooperative stop is only meaningful here, because the job boundary is
   * the only place where stopping costs nothing: the work is committed, the
   * marker is current, and the next run resumes from it by the ordinary path
   * (§4.4). It is asked rather than passed as a flag so that a stop arriving
   * mid-job is still not acted on until the boundary.
   */
  readonly stopRequested?: () => boolean;
  readonly now?: () => Date;
}

export interface DriveResult {
  /**
   * The marker as the drive left it, on disk: `VERIFYING`, or `EXECUTING` at
   * the boundary a cooperative stop ended it on.
   */
  readonly marker: StateMarker;
  readonly block: OpenTourBlock;
  /** The job indexes this run actually handed to the session, in order. */
  readonly ran: readonly number[];
  /** Where the run picked up, which a resumed run answers differently. */
  readonly resumedAt: number;
  /**
   * Whether the usage ceiling ended the tour before its job list was done
   * (FR-1.4, D-66).
   *
   * A tour stopped by its budget is not a failure and must not travel the
   * abandonment path, which exists for a tour that could not go green (D-35).
   * It leaves EXECUTING for VERIFYING exactly as a finished tour does.
   */
  readonly carried: boolean;
  /** The disposition the closure is to record (§3.2, §4.6 step 5). */
  readonly disposition: TourDisposition;
  /**
   * The reading the decision was made on, or null where no boundary was
   * crossed and no reading was taken.
   *
   * Null rather than a `within` standing in for it: a check that never ran is
   * not a check that found the tour affordable, and reporting the second for
   * the first is how "no data" gets read as "zero".
   */
  readonly ceiling: CeilingVerdict | null;
  /**
   * Whether a cooperative stop ended the run before the job list was done
   * (D-83).
   *
   * Kept apart from `carried`, which it resembles and is not: a carried tour
   * spent its budget and closes through `CLOSING`, while a stopped one is put
   * down at a boundary with its tour still open and picked up by the next run.
   * The marker says the same thing, since a stopped drive never advances to
   * `VERIFYING`.
   */
  readonly stopped: boolean;
}

/** A job the loop handed to the session and got no progress on. */
export class JobDidNotAdvanceError extends Error {
  readonly jobIndex: number;

  constructor(jobIndex: number, criterion: string) {
    super(
      `job ${jobIndex + 1} was run and its acceptance criterion still does not pass: ${criterion}. The loop stops rather than handing the same job over again, because a loop that cannot make progress is not a retry (SDD §4.2).`,
    );
    this.name = 'JobDidNotAdvanceError';
    this.jobIndex = jobIndex;
  }
}

/**
 * Re-reads the job list at a boundary (§4.2, D-95).
 *
 * The block on disk is the durable record and the drive's copy is not, so a
 * row appended since entry belongs to this run rather than to the next one.
 * A block that has stopped parsing stops the drive: the guard that holds the
 * Implementer to statuses and appends should have refused whatever did it, so
 * a malformed block here is evidence of a defect rather than a list to guess
 * at (SRS §3.5).
 */
function rereadJobList(input: DriveExecutingInput, current: OpenTourBlock): OpenTourBlock {
  const read = readOpenTour(input.root, input.config.docRoot);
  if (read.kind === 'open') return read.block;
  if (read.kind === 'none') {
    throw new Error(
      'the open-tour block was cleared while the job list was being driven, and clearing it is closure step 6 (SDD §4.6, FR-2.1).',
    );
  }
  throw new Error(
    `the open-tour block stopped parsing while the job list was being driven (${read.field}: ${read.problem}). It carried ${current.jobs.length} jobs when the drive started, and a list resumption depends on is never guessed at (SRS §3.5).`,
  );
}

/**
 * Drives `EXECUTING` to its exit.
 *
 * Returns when every job's acceptance criterion passes and the marker reads
 * `VERIFYING`. Throws where it cannot make progress, rather than looping: an
 * orchestrator that spins on one job spends the budget FR-1.3 exists to bound
 * without ever raising the gate that bounds it.
 */
export async function driveExecuting(input: DriveExecutingInput): Promise<DriveResult> {
  assertDrivenState(input.marker, 'EXECUTING');

  const read = readOpenTour(input.root, input.config.docRoot);
  if (read.kind === 'none') {
    throw new Error(
      'no tour is open, so there is no job list to drive. The open-tour block is the durable home of the jobs and their criteria (SRS §3.5, D-37).',
    );
  }
  if (read.kind === 'malformed') {
    throw new Error(
      `the open-tour block does not parse (${read.field}: ${read.problem}), so the job list cannot be read. A block resumption depends on is never guessed at (SRS §3.5).`,
    );
  }

  let block = read.block;
  const now = input.now ?? (() => new Date());
  const rules = { attemptBudget: input.config.attemptBudget };
  const ran: number[] = [];
  let marker = input.marker;
  // Null until the first job this run actually handles. A sentinel of "the
  // length" would move under the re-read below, since the list can grow while
  // the drive is running (D-95).
  let firstHandled: number | null = null;
  let carried = false;
  let stopped = false;
  // Not read before the first boundary. The rule is defined from job 1,
  // because at the first boundary the largest job so far is the job just
  // finished; checking earlier would compare against a largest job of zero.
  let ceiling: CeilingVerdict | null = null;

  // A ceiling on how many jobs one drive may run, independent of the list it
  // is reading. The list can grow while the drive is running (D-95), and a
  // session that appended a row per boundary would turn that into a loop with
  // nothing on disk saying why. Set far above any real tour: an audit raises a
  // job or two, not a job per job.
  const jobCeiling = block.jobs.length * 2 + 8;

  for (let index = 0; index < block.jobs.length; index += 1) {
    if (index >= jobCeiling) {
      throw new Error(
        `the job list grew to ${block.jobs.length} rows while this drive was running, past the ${jobCeiling} this tour started with room for. An audit raises a job or two (D-95); a list that grows once per boundary is a loop, and the drive stops rather than following it (SDD §4.2).`,
      );
    }
    const job = block.jobs[index] as TourJob;
    if (await input.session.acceptancePasses(job, index)) continue;
    firstHandled ??= index;

    await input.session.runJob(job, index);
    ran.push(index);

    if (!(await input.session.acceptancePasses(job, index))) {
      throw new JobDidNotAdvanceError(index, job.criterion);
    }

    // The boundary: the job is done, its commit exists, and the marker is
    // written once to record it (D-47). The session already wrote the status
    // into the same staged set as that commit (D-65).
    marker = advance(
      input.root,
      marker,
      { type: 'job-boundary', jobIndex: index + 1 },
      rules,
      now(),
    ).marker;

    // The list is re-read at the boundary, because the session may have
    // appended a row for a job an audit raised since the drive started (D-95,
    // D-34). A drive holding the list it read at entry would exit to
    // `VERIFYING` with that job unrun, which is the loss D-95 exists to
    // prevent, arriving without a death to blame.
    block = rereadJobList(input, block);

    // The ceiling is read at the boundary and never mid-job (FR-1.4): the job
    // is green and committed by the time this runs, which is the whole reason
    // the check has a moment rather than a moving threshold.
    ceiling = ceilingVerdict(input.root, input.config, marker.tourId);
    // Only where a job is left to be stopped before. A ceiling reached at the
    // last boundary stopped nothing: the tour finished its list, and calling
    // that carried would hand a successor an empty list to plan from.
    if (ceiling.kind === 'reached' && index + 1 < block.jobs.length) {
      carried = true;
      break;
    }

    // The cooperative stop, asked at the same moment and under the same rule
    // as the ceiling: only where a job is left to be stopped before. A stop
    // asked on the last boundary stopped nothing, and reporting it as a detach
    // would leave a finished tour looking unfinished (D-83).
    if (input.stopRequested?.() === true && index + 1 < block.jobs.length) {
      stopped = true;
      break;
    }
  }

  // A stopped drive does not advance: the tour keeps its open list and the
  // next run resumes from this boundary by the ordinary path (§4.4, §5.1).
  const resumedAt = firstHandled ?? block.jobs.length;
  if (stopped) {
    return { marker, block, ran, resumedAt, carried, disposition: 'closed', ceiling, stopped };
  }

  marker = advance(input.root, marker, { type: 'jobs-done' }, rules, now()).marker;
  return {
    marker,
    block,
    ran,
    resumedAt,
    carried,
    // A tour stopped by its budget is not a failure and must not travel the
    // abandonment path, which exists for a tour that could not go green
    // (D-35, D-66).
    disposition: carried ? 'carried' : 'closed',
    ceiling,
    stopped,
  };
}
