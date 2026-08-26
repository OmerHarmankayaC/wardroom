import { ensureRunDir, wardroomPaths } from '../config/paths.js';
import { appendJsonLine, readJsonLines } from '../fs/jsonl.js';

/**
 * The owner's out-of-band context for the roles (SDD §3.0, §5.1, FR-5.2,
 * D-108).
 *
 * Append-only, one line per injection, each carrying its text, when it was
 * written, and whether it has been delivered. It is a file rather than a
 * message because nothing is running most of the time: `run` drives one cycle
 * and returns (D-83), so an injection almost always arrives while no session
 * exists, and an operation whose effect depends on a process happening to be
 * alive is not an operation.
 *
 * Delivery is recorded rather than the line being removed, so `history.log`
 * can show what the owner told the roles and when, and so a session that dies
 * before reading does not consume the note.
 *
 * An injection is context and not a decision in the TD-2 sense: it releases no
 * gate, and where the owner means to decide something gate shaped,
 * `gate.decide` is the operation.
 */

export interface InboxLine {
  readonly text: string;
  readonly writtenAt: string;
  /** When the line reached a session's opening prompt, or null while it has not. */
  readonly deliveredAt: string | null;
}

interface OnDiskLine {
  text: string;
  written_at: string;
  delivered_at: string | null;
}

function toOnDisk(line: InboxLine): OnDiskLine {
  return {
    text: line.text,
    written_at: line.writtenAt,
    delivered_at: line.deliveredAt,
  };
}

/** A line that is not the shape this module writes, so a reader can say so. */
export class InboxLineUnreadableError extends Error {
  constructor(problem: string) {
    super(`the inbox holds a line this reader cannot use: ${problem} (SDD §3.0, D-108)`);
    this.name = 'InboxLineUnreadableError';
  }
}

function fromOnDisk(raw: unknown): InboxLine {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new InboxLineUnreadableError('a line is not a JSON object');
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.text !== 'string') throw new InboxLineUnreadableError('text must be a string');
  if (typeof record.written_at !== 'string') {
    throw new InboxLineUnreadableError('written_at must be a timestamp');
  }
  if (record.delivered_at !== null && typeof record.delivered_at !== 'string') {
    throw new InboxLineUnreadableError('delivered_at must be a timestamp or null');
  }
  return {
    text: record.text,
    writtenAt: record.written_at,
    deliveredAt: record.delivered_at as string | null,
  };
}

/** Appends one injection. Never reads, never rewrites, never truncates. */
export function appendInbox(root: string, line: InboxLine): void {
  ensureRunDir(root);
  appendJsonLine(wardroomPaths(root).inboxFile, toOnDisk(line));
}

/**
 * Every line, oldest first. An absent file is an empty inbox, not an error: a
 * repository nobody has said anything to has nothing to read.
 */
export function readInbox(root: string): InboxLine[] {
  return readJsonLines(wardroomPaths(root).inboxFile).map(fromOnDisk);
}

/** The lines no session has been given yet, oldest first. */
export function undelivered(root: string): InboxLine[] {
  return readInbox(root).filter((line) => line.deliveredAt === null);
}
