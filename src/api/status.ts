import { loadConfig } from '../config/load.js';
import type { ProjectConfig } from '../config/schema.js';
import { parkElapsedGate } from '../gates/parking.js';
import { list } from '../gates/queue.js';
import type { GateEntry } from '../gates/schema.js';
import { type CeilingVerdict, ceilingAgainst } from '../loop/ceiling.js';
import { type OpenTourRead, type TourJob, readOpenTour } from '../progress/open-tour.js';
import { type MarkerRead, type TourState, readMarker } from '../state/marker.js';
import { type UsageSummary, usageSummary } from '../usage/record.js';

/**
 * What the project is doing, answered from files alone (SDD §5.1, FR-1.4,
 * FR-3.3).
 *
 * Nothing here starts a session, runs a command or touches a remote. `status`
 * is the operation an owner reaches for when they have come back to a
 * repository they left, and an operation that had to run something to answer
 * would be unusable at exactly that moment.
 *
 * Every field is reported rather than resolved. An unreadable marker is
 * reported as unreadable and not as `IDLE` (§4.4 step 1, D-20); an open-tour
 * block that does not parse is reported with the field that failed rather than
 * as no tour; a meter that did not run is reported as not measured rather than
 * as zero (D-80). A surface may present these however it likes, and none of
 * them may be flattened here, because flattening is where "no data" becomes
 * "nothing wrong".
 */

/** The job the tour is at, as the two records see it. */
export interface CurrentJob {
  /** Zero based, as the marker carries it. */
  readonly index: number;
  /** The row at that index, or null where the block carries no such row. */
  readonly job: TourJob | null;
}

export interface ProjectStatus {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as read, unreadable and absent kept apart (D-20). */
  readonly marker: MarkerRead;
  /** The state, or null where no marker could be read. A convenience, not a fact of its own. */
  readonly state: TourState | null;
  readonly openTour: OpenTourRead;
  readonly currentJob: CurrentJob | null;
  /** Pending and parked gates, which are the same status with a stamp (D-27). */
  readonly gates: readonly GateEntry[];
  readonly usage: UsageSummary;
  /**
   * Where the tour stands against its ceiling (FR-1.4, D-66).
   *
   * The very verdict the drive acts on at a job boundary, asked here without
   * making one, and asked through the same function rather than restated: two
   * statements of the rule would be two places for the boundary to move, and a
   * surface reporting one answer while the drive acts on another is the worst
   * version of that. `reached` here means the next boundary closes the tour.
   */
  readonly budget: CeilingVerdict;
}

function currentJobOf(marker: MarkerRead, openTour: OpenTourRead): CurrentJob | null {
  if (marker.kind !== 'ok' || marker.marker.jobIndex === null) return null;
  const index = marker.marker.jobIndex;
  const job = openTour.kind === 'open' ? (openTour.block.jobs[index] ?? null) : null;
  return { index, job };
}

export interface StatusOptions {
  /** The moment being read at, for the parking computation (D-107). */
  readonly now?: Date;
}

/** State, open tour, current job, gates and usage against budget (§5.1). */
export function projectStatus(root: string, options: StatusOptions = {}): ProjectStatus {
  const config = loadConfig(root);

  // Parked is computed on reading, not stamped by a timer (D-107). `run` may
  // have exited hours ago and there is no daemon, so a gate whose waiting
  // period ran out overnight is parked by whoever reads it next. This is one
  // of the three readers that does, and all three call the same function so
  // that they cannot answer differently.
  parkElapsedGate(root, config, options.now === undefined ? {} : { now: options.now });

  const marker = readMarker(root);
  const openTour = readOpenTour(root, config.docRoot);
  const tourId = marker.kind === 'ok' ? marker.marker.tourId : null;
  const usage = usageSummary(root, { tourId, authMode: config.authMode });

  return {
    root,
    config,
    marker,
    state: marker.kind === 'ok' ? marker.marker.state : null,
    openTour,
    currentJob: currentJobOf(marker, openTour),
    gates: list(root),
    usage,
    budget: ceilingAgainst(usage, config.usageBudget.usd),
  };
}
