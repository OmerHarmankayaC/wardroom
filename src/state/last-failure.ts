import { readFileSync, rmSync } from 'node:fs';
import { wardroomPaths } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';
import { isJsonObject } from '../json/guards.js';

/**
 * `last-failure.json` (SDD §3.0, BACKLOG D-48, D-59).
 *
 * The failure the current attempt count was spent on, in one of two shapes: a
 * failed verification, or a plan that did not parse. Both name the attempt
 * they belong to. The record is replaced at each failure and cleared when the
 * cycle reaches `IDLE`.
 *
 * One file rather than two, because one counter is spent by both (§3.2, D-60)
 * and the `tour-budget` gate reads whichever failure exhausted it.
 *
 * It exists because that gate's preview requires the evidence (§3.1), and
 * because a process can die in `FAILED` or between planning attempts, and
 * re-running to reconstruct it is not equivalent: a re-run can pass, leaving
 * the owner asked to decide about a failure that no longer reproduces. It
 * stays out of the marker, which is written at every transition and has to
 * remain small enough to replace atomically (§3.3).
 */

export interface VerificationFailureRecord {
  readonly kind: 'verification';
  /** The attempt this failure was spent on (§3.2, D-60). */
  readonly attempt: number;
  readonly command: string;
  readonly exitCode: number;
  /** May be empty: a command can fail while printing nothing (§3.1). */
  readonly output: string;
}

export interface PlanningFailureRecord {
  readonly kind: 'planning';
  readonly attempt: number;
  /** The open-tour block field that failed to parse (SRS §3.5). */
  readonly field: string;
  readonly problem: string;
}

export type LastFailure = VerificationFailureRecord | PlanningFailureRecord;

interface OnDiskVerification {
  kind: 'verification';
  attempt: number;
  command: string;
  exit_code: number;
  output: string;
}

interface OnDiskPlanning {
  kind: 'planning';
  attempt: number;
  field: string;
  problem: string;
}

function toOnDisk(record: LastFailure): OnDiskVerification | OnDiskPlanning {
  return record.kind === 'verification'
    ? {
        kind: 'verification',
        attempt: record.attempt,
        command: record.command,
        exit_code: record.exitCode,
        output: record.output,
      }
    : { kind: 'planning', attempt: record.attempt, field: record.field, problem: record.problem };
}

/** Replaces the record atomically, as every durable record here is replaced. */
export function writeLastFailure(root: string, record: LastFailure): void {
  atomicWriteFile(
    wardroomPaths(root).lastFailureFile,
    `${JSON.stringify(toOnDisk(record), null, 2)}\n`,
  );
}

function isAttempt(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

/**
 * The record, or null where there is none this can be sure of.
 *
 * Null covers absent, unparseable and a shape that is neither of the two, and
 * that is deliberate rather than lazy: §4.4's `FAILED` branch re-runs
 * verification when the record is absent rather than guessing which side of
 * the budget the tour was on, and a record it cannot read has to reach that
 * same branch. Answering half a record instead would put a guess into the
 * preview an owner decides on.
 */
export function readLastFailure(root: string): LastFailure | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(wardroomPaths(root).lastFailureFile, 'utf8'));
  } catch {
    return null;
  }
  if (!isJsonObject(raw) || !isAttempt(raw.attempt)) return null;

  if (raw.kind === 'verification') {
    if (
      typeof raw.command !== 'string' ||
      !Number.isInteger(raw.exit_code) ||
      typeof raw.output !== 'string'
    ) {
      return null;
    }
    return {
      kind: 'verification',
      attempt: raw.attempt as number,
      command: raw.command,
      exitCode: raw.exit_code as number,
      output: raw.output,
    };
  }

  if (raw.kind === 'planning') {
    if (typeof raw.field !== 'string' || typeof raw.problem !== 'string') return null;
    return {
      kind: 'planning',
      attempt: raw.attempt as number,
      field: raw.field,
      problem: raw.problem,
    };
  }

  return null;
}

/** Clears the record, as the cycle reaching `IDLE` does (§3.2, §4.6 step 7). */
export function clearLastFailure(root: string): void {
  rmSync(wardroomPaths(root).lastFailureFile, { force: true });
}

/**
 * The one line of evidence the `tour-budget` preview carries (§3.1).
 *
 * Stated here rather than at the gate, so the two shapes are rendered where
 * they are defined and a third shape could not be added without this seeing it.
 */
export function failureEvidence(record: LastFailure | null): string {
  if (record === null) {
    return 'no failure record survives, so the evidence for this decision could not be recovered.';
  }
  return record.kind === 'verification'
    ? `\`${record.command}\` exited ${record.exitCode}:\n${record.output}`
    : `the plan did not parse (${record.field}: ${record.problem}).`;
}
