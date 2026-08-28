import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { wardroomPaths } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';
import { isJsonObject } from '../json/guards.js';
import { TOUR_STATES, type TourState } from '../state/marker.js';
import { GATE_ID_PATTERN } from './id.js';
import { previewProblem } from './preview.js';
import {
  GATE_CLASSES,
  GATE_STATUSES,
  type GateClass,
  type GateEntry,
  type GatePreview,
  type GateStatus,
  PRE_RECORD_GATE_CLASSES,
} from './schema.js';

/**
 * One file per gate at `.wardroom/run/gates/<gate_id>.json` (SDD §3.0, §3.1).
 *
 * Entries are written through the same atomic mechanism as the state marker
 * (../fs/atomic.ts): a gate entry is read by a person deciding whether to let
 * something irreversible happen, and half a preview is worse than none.
 *
 * v1 does not archive (BACKLOG D-29). A resolved entry stays where it was
 * written, which is why `listEntryIds` returns every entry and the filtering
 * belongs to the queue operation above it.
 */

/** A gate entry file that is present but cannot be trusted. */
export class GateSchemaError extends Error {
  readonly gateId: string;
  readonly problems: readonly string[];

  constructor(gateId: string, problems: readonly string[]) {
    super(`gate ${gateId} is not a usable entry:\n  - ${problems.join('\n  - ')}`);
    this.name = 'GateSchemaError';
    this.gateId = gateId;
    this.problems = problems;
  }
}

interface OnDiskEntry {
  gate_id: string;
  class: string;
  status: string;
  tour_id: string | null;
  job_index: number | null;
  interrupted_state: string;
  what: string;
  why: string;
  preview: Record<string, unknown>;
  recommendation: string | null;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
  parked_at: string | null;
}

export function entryPath(root: string, gateId: string): string {
  return join(wardroomPaths(root).gatesDir, `${gateId}.json`);
}

/**
 * The preview's `kind` is not stored: it is the gate's class, and one fact
 * gets one home. Read restores it from `class`, so the two can never disagree
 * on disk because only one of them is there.
 */
function toOnDisk(entry: GateEntry): OnDiskEntry {
  const { kind: _discardedDiscriminant, ...preview } = entry.preview;
  return {
    gate_id: entry.gateId,
    class: entry.gateClass,
    status: entry.status,
    tour_id: entry.tourId,
    job_index: entry.jobIndex,
    interrupted_state: entry.interruptedState,
    what: entry.what,
    why: entry.why,
    preview,
    recommendation: entry.recommendation,
    requested_at: entry.requestedAt,
    decided_at: entry.decidedAt,
    decided_by: entry.decidedBy,
    decision_note: entry.decisionNote,
    parked_at: entry.parkedAt,
  };
}

/**
 * `recommendation` under D-114 and D-116, the fourth determinate emptiness.
 *
 * Absent is accepted, and so is null: most gates are raised by the hook inside
 * an Implementer session where no role was asked, so having no recommendation
 * is the ordinary case. Left uncounted, the reader D-70 tightened would have
 * refused nearly every entry there is, which is the same defect as the empty
 * `tour_id`, one field over and one tour later.
 *
 * A present-but-blank string is refused, exactly as an empty `tour_id` is.
 * Null says nobody advised; a blank string says somebody meant to and did not,
 * and an owner shown the first when the truth is the second is being told
 * there was no view to have.
 */
function collectRecommendationProblem(raw: Record<string, unknown>, problems: string[]): void {
  const value = raw.recommendation;
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    problems.push('recommendation: must be a string or null (SDD §3.1, D-114).');
    return;
  }
  if (value.trim() === '') {
    problems.push(
      'recommendation: is empty. A gate nobody advised on carries null, which says no role was asked; an empty string says only that somebody failed to fill the field (SDD §3.1, D-32, D-70, D-116).',
    );
  }
}

function isOptionalString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/**
 * `tour_id` under D-70: null for a gate raised before any tour record exists,
 * a named tour otherwise, and never an empty string.
 *
 * Null is accepted for exactly the pre-record classes and refused for every
 * other, so a missing identifier cannot pass as a pre-record one. An empty
 * string is refused everywhere, because null is a determinate fact about the
 * action, that nothing has been planned, and an empty string is a field
 * somebody failed to fill: reading the second as the first is the collapse
 * D-32 forbids.
 */
function collectTourIdProblem(raw: Record<string, unknown>, problems: string[]): void {
  const tourId = raw.tour_id;

  if (tourId === null) {
    if (!(PRE_RECORD_GATE_CLASSES as readonly unknown[]).includes(raw.class)) {
      problems.push(
        `tour_id: null names no tour, which only ${PRE_RECORD_GATE_CLASSES.join(' and ')} may do, since they are the classes raised before a tour record exists (SDD §3.1, D-70). A ${String(raw.class)} gate is raised from inside a tour and names it.`,
      );
    }
    return;
  }

  if (typeof tourId !== 'string') {
    problems.push('tour_id: must name the tour the gate was raised in, or be null.');
    return;
  }
  if (tourId.trim() === '') {
    problems.push(
      'tour_id: is empty. A gate raised before any tour record exists carries null, which says no tour was planned; an empty string says only that nobody filled the field (SDD §3.1, D-32, D-70).',
    );
  }
}

function collectProblems(raw: unknown, problems: string[]): void {
  if (!isJsonObject(raw)) {
    problems.push('the entry is not a JSON object.');
    return;
  }

  if (typeof raw.gate_id !== 'string' || !GATE_ID_PATTERN.test(raw.gate_id)) {
    problems.push('gate_id: must match `g-<YYYYMMDDTHHMMSSZ>-<4 hex>` (BACKLOG D-28).');
  }
  if (!GATE_CLASSES.includes(raw.class as GateClass)) {
    problems.push(`class: must be one of ${GATE_CLASSES.join(', ')} (SRS TD-2).`);
  }
  if (!GATE_STATUSES.includes(raw.status as GateStatus)) {
    problems.push(
      `status: must be one of ${GATE_STATUSES.join(', ')}. Expiry is not a status: it stamps parked_at and leaves the gate pending (BACKLOG D-27).`,
    );
  }
  collectTourIdProblem(raw, problems);
  if (
    raw.job_index !== null &&
    !(Number.isInteger(raw.job_index) && (raw.job_index as number) >= 0)
  ) {
    problems.push('job_index: must be a non-negative whole number or null.');
  }
  if (!(TOUR_STATES as readonly unknown[]).includes(raw.interrupted_state)) {
    problems.push('interrupted_state: must name the state to return to (SDD §3.2).');
  }
  if (typeof raw.what !== 'string' || raw.what.trim() === '') {
    problems.push('what: must state the action being requested, in one line.');
  }
  if (typeof raw.why !== 'string' || raw.why.trim() === '') {
    problems.push('why: must state the rule that classified this as a gate.');
  }
  if (typeof raw.requested_at !== 'string' || raw.requested_at === '') {
    problems.push('requested_at: must be a timestamp.');
  }
  for (const field of ['decided_at', 'decided_by', 'decision_note', 'parked_at']) {
    if (!isOptionalString(raw[field])) problems.push(`${field}: must be a string or null.`);
  }
  collectRecommendationProblem(raw, problems);

  if (GATE_CLASSES.includes(raw.class as GateClass)) {
    const gateClass = raw.class as GateClass;
    const preview = isJsonObject(raw.preview) ? { ...raw.preview, kind: gateClass } : raw.preview;
    const problem = previewProblem(gateClass, preview);
    if (problem !== null) problems.push(problem);
  }

  // A pending entry that carries a decision, or a decided one that carries
  // none, is a record whose two halves disagree. Reading it either way would
  // be guessing which half is the truth.
  const decided = raw.status === 'approved' || raw.status === 'rejected';
  if (decided && (raw.decided_at === null || raw.decided_by === null)) {
    problems.push('a decided gate records decided_at and decided_by (SDD §3.1).');
  }
  if (!decided && raw.decided_at !== null) {
    problems.push('a pending gate carries no decided_at: parking is not a decision (D-27).');
  }
}

function fromOnDisk(raw: OnDiskEntry): GateEntry {
  const gateClass = raw.class as GateClass;
  return {
    gateId: raw.gate_id,
    gateClass,
    status: raw.status as GateStatus,
    tourId: raw.tour_id,
    jobIndex: raw.job_index,
    interruptedState: raw.interrupted_state as TourState,
    what: raw.what,
    why: raw.why,
    preview: { ...raw.preview, kind: gateClass } as GatePreview,
    // Absent reads as null: an entry written before this field existed, or one
    // raised by the hook with no role to ask, and neither is a missing field
    // (§3.1, D-116).
    recommendation: raw.recommendation ?? null,
    requestedAt: raw.requested_at,
    decidedAt: raw.decided_at,
    decidedBy: raw.decided_by,
    decisionNote: raw.decision_note,
    parkedAt: raw.parked_at,
  };
}

/** Writes the entry atomically, creating the gates directory on demand. */
export function writeEntry(root: string, entry: GateEntry): void {
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  atomicWriteFile(entryPath(root, entry.gateId), `${JSON.stringify(toOnDisk(entry), null, 2)}\n`);
}

/**
 * Reads one entry. Absent is null; present but unusable throws, because an
 * entry the owner is waiting on must never be silently treated as missing.
 */
export function readEntry(root: string, gateId: string): GateEntry | null {
  let text: string;
  try {
    text = readFileSync(entryPath(root, gateId), 'utf8');
  } catch {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new GateSchemaError(gateId, [
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const problems: string[] = [];
  collectProblems(raw, problems);
  if (problems.length > 0) throw new GateSchemaError(gateId, problems);

  return fromOnDisk(raw as unknown as OnDiskEntry);
}

/**
 * Every gate identifier on disk, sorted. Sorting by name is sorting by the
 * order the gates were raised, which D-28 designed the identifier to give.
 * The audit log lives in the same directory and is deliberately not an entry.
 */
export function listEntryIds(root: string): string[] {
  const { gatesDir } = wardroomPaths(root);
  let names: string[];
  try {
    names = readdirSync(gatesDir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .filter((id) => GATE_ID_PATTERN.test(id))
    .sort();
}
