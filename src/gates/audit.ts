import { wardroomPaths } from '../config/paths.js';
import { appendJsonLine, readJsonLines } from '../fs/jsonl.js';

/**
 * The gate audit log (SDD §3.1): `.wardroom/run/gates/audit.jsonl`,
 * append-only, one JSON object per line.
 *
 * It is a separate file from the entries because the audit trail is never
 * archived while entries one day may be (FR-3.2, BACKLOG D-29, B-11). It is
 * also written by a different mechanism, deliberately: entries go through
 * ../fs/atomic.ts, which replaces a whole file, and replacing a whole file is
 * the one thing an append-only log must never do.
 *
 * The line is written BEFORE the action it records, so a crash mid-action
 * leaves evidence rather than silence. That ordering is enforced by
 * {@link recordThenAct} rather than left to each call site to remember: a
 * convention every caller must observe is a convention one caller eventually
 * will not.
 */

/**
 * `consumed` records the call an approval authorized being made (SDD §3.1,
 * §3.2, D-61). It is the only evidence that an approval was spent rather than
 * still standing: the entry schema has no field for it, so the log is not
 * merely a trail here, it is the record the authorization check reads.
 */
export const AUDIT_EVENTS = ['enqueued', 'parked', 'decided', 'consumed'] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export interface AuditLine {
  readonly ts: string;
  readonly gateId: string;
  readonly event: AuditEvent;
  readonly payload: Readonly<Record<string, unknown>>;
}

interface OnDiskLine {
  ts: string;
  gate_id: string;
  event: AuditEvent;
  payload: Record<string, unknown>;
}

/** Appends one line. Never reads, never rewrites, never truncates. */
export function appendAuditLine(root: string, line: AuditLine): void {
  const onDisk: OnDiskLine = {
    ts: line.ts,
    gate_id: line.gateId,
    event: line.event,
    payload: { ...line.payload },
  };
  appendJsonLine(wardroomPaths(root).auditLog, onDisk);
}

/**
 * Writes the audit line, then performs the action.
 *
 * If the action throws, the line stays: the log records what was attempted,
 * which is exactly what a crash between the two must leave behind. The reverse
 * order would lose the record of every action that failed halfway, and those
 * are the ones anyone reading the log later is looking for.
 */
export function recordThenAct<T>(root: string, line: AuditLine, action: () => T): T {
  appendAuditLine(root, line);
  return action();
}

/**
 * Every line in the log, oldest first.
 *
 * A trailing partial line is ignored rather than raised. A process killed
 * mid-append can leave one, and refusing to read the whole log because of its
 * last few bytes would lose the evidence the log exists to keep. Anything else
 * unparsable is a corrupted trail and is reported.
 */
export function readAuditLines(root: string): AuditLine[] {
  return readJsonLines(wardroomPaths(root).auditLog).map((raw) => {
    const record = raw as OnDiskLine;
    return {
      ts: record.ts,
      gateId: record.gate_id,
      event: record.event,
      payload: record.payload,
    };
  });
}
