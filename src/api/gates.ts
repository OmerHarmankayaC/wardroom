import { loadConfig } from '../config/load.js';
import { parkElapsedGate } from '../gates/parking.js';
import { decide, list, show } from '../gates/queue.js';
import type { GateEntry } from '../gates/schema.js';

/**
 * The three gate operations (SDD §5.1, FR-3.1, FR-3.2).
 *
 * Thin by design. The queue below already owns the entry file, the audit line
 * and the refusal of a second decision, and an operation layer that re-decided
 * any of that would be a second home for the rules FR-3.1 rests on. What this
 * layer adds is the shape of the operation set: a project path first, the same
 * arguments from every surface, and no privileged path available to one of
 * them (FR-5.1).
 *
 * `gate.show` takes the project as well as the identifier, which the §5.1
 * table does not. An identifier alone cannot say which repository it belongs
 * to: entries live under a project's `run/gates/`, and there is no registry of
 * projects to search. The table's signature is reported as a document debt
 * rather than worked around by inventing one.
 */

/** Who a decision is recorded as, where a surface names nobody (FR-3.2). */
export const DEFAULT_DECIDER = 'owner';

export interface GateListOptions {
  readonly includeResolved?: boolean;
  /** The moment being read at, for the parking computation (D-107). */
  readonly now?: Date;
}

/**
 * Pending and parked gates, oldest first (FR-3.1, FR-3.3).
 *
 * Reading is what parks a tour whose waiting period has run out (D-107), so
 * this asks the same question `status` and `run` ask, through the same
 * function. A listing that showed a gate as merely pending because nothing
 * happened to be alive when its wait elapsed would be the exact failure
 * `PARKED` exists to prevent.
 */
export function gateList(root: string, options: GateListOptions = {}): GateEntry[] {
  parkElapsedGate(root, loadConfig(root), options.now === undefined ? {} : { now: options.now });
  return list(
    root,
    options.includeResolved === undefined ? {} : { includeResolved: options.includeResolved },
  );
}

export interface GateShowOptions {
  /** The moment being read at, for the parking computation (D-107). */
  readonly now?: Date;
}

/**
 * One gate with its full class preview (§3.1), resolved or not (D-29).
 *
 * It parks for the same reason {@link gateList} does, and this was missed when
 * D-107 was implemented: the decision names `status`, `gates` and `run`, and
 * `gate <id>` is a fourth reader that did not exist yet. Without it the two
 * commands an owner uses together disagree about the same entry, the listing
 * calling it parked and the detail calling it merely pending, which is the
 * inconsistency D-107's "identically" exists to prevent.
 */
export function gateShow(root: string, gateId: string, options: GateShowOptions = {}): GateEntry {
  parkElapsedGate(root, loadConfig(root), options.now === undefined ? {} : { now: options.now });
  return show(root, gateId);
}

export interface DecideInput {
  readonly decision: 'approved' | 'rejected';
  readonly note?: string | null;
  /** Who decided. Recorded, because FR-3.2 audits decisions and not just outcomes. */
  readonly decidedBy?: string;
  readonly now?: Date;
}

/**
 * Records the owner's decision and releases the waiting tour (FR-3.1, FR-3.2).
 *
 * Releasing is not a step this function takes. The interceptor is blocked on
 * the entry file and re-reads it from disk rather than from anything held in
 * memory, precisely so that the decision can arrive from a surface the running
 * process does not share (§3.1, D-29). Writing the entry IS the release.
 */
export function gateDecide(root: string, gateId: string, input: DecideInput): GateEntry {
  return decide(
    root,
    gateId,
    input.decision,
    input.decidedBy ?? DEFAULT_DECIDER,
    input.note ?? null,
    input.now === undefined ? {} : { now: input.now },
  );
}
