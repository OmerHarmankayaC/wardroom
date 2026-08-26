import { ensureRunDir, wardroomPaths } from '../config/paths.js';
import { appendJsonLine, readJsonLines } from '../fs/jsonl.js';

/**
 * The owner's out-of-band context for the roles (SDD §3.0, §5.1, FR-5.2,
 * D-108).
 *
 * One line per injection, each carrying its text and when it was written. It
 * is a file rather than a message because nothing is running most of the time:
 * `run` drives one cycle and returns (D-83), so an injection almost always
 * arrives while no session exists, and an operation whose effect depends on a
 * process happening to be alive is not an operation.
 *
 * A session receives every undelivered line in its opening prompt, and the
 * orchestrator marks those lines delivered at that moment. Delivery is
 * recorded rather than the line being removed, so `history.log` can show what
 * the owner told the roles and when, and so a session that dies before reading
 * does not consume the note.
 *
 * **How delivery is recorded, and why not on the line itself.** D-108 asks for
 * two things that cannot both be had literally: a file that is append-only,
 * and a per line flag saying whether that line has been delivered. Stamping
 * the line means rewriting the file, and a rewrite has a window: an injection
 * appended between the read and the write is silently lost, which is the
 * owner's message vanishing with nothing anywhere saying so.
 *
 * So delivery is a record of its own, appended like any other: one line saying
 * how many injections have been delivered and when. Delivery always takes
 * every undelivered line in order, so a count is exactly as expressive as a
 * per line flag, and an injection that arrives mid delivery simply lands after
 * the mark and waits for the next session. The flag readers see is derived
 * from the mark rather than stored, which is the one difference from the
 * document's wording and is reported as a debt.
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

/** A line that is not a shape this module writes, so a reader can say so. */
export class InboxLineUnreadableError extends Error {
  constructor(problem: string) {
    super(`the inbox holds a line this reader cannot use: ${problem} (SDD §3.0, D-108)`);
    this.name = 'InboxLineUnreadableError';
  }
}

/** An injection as it sits on disk. Delivery is not among its fields, by design. */
interface OnDiskInjection {
  text: string;
  written_at: string;
}

/** How far delivery has reached, appended when a session's prompt is built. */
interface OnDiskDelivery {
  delivered_through: number;
  at: string;
}

function isDelivery(raw: Record<string, unknown>): boolean {
  return Object.hasOwn(raw, 'delivered_through');
}

function readDelivery(raw: Record<string, unknown>): OnDiskDelivery {
  if (!Number.isInteger(raw.delivered_through) || (raw.delivered_through as number) < 0) {
    throw new InboxLineUnreadableError('delivered_through must be a non-negative whole number');
  }
  if (typeof raw.at !== 'string' || raw.at === '') {
    throw new InboxLineUnreadableError('a delivery record carries the moment it happened');
  }
  return { delivered_through: raw.delivered_through as number, at: raw.at };
}

function readInjection(raw: Record<string, unknown>): OnDiskInjection {
  if (typeof raw.text !== 'string') throw new InboxLineUnreadableError('text must be a string');
  if (typeof raw.written_at !== 'string' || raw.written_at === '') {
    throw new InboxLineUnreadableError('written_at must be a timestamp');
  }
  return { text: raw.text, written_at: raw.written_at };
}

/** Every record on disk, in order, split into the two kinds. */
function records(root: string): {
  injections: OnDiskInjection[];
  deliveries: OnDiskDelivery[];
} {
  const injections: OnDiskInjection[] = [];
  const deliveries: OnDiskDelivery[] = [];
  for (const raw of readJsonLines(wardroomPaths(root).inboxFile)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new InboxLineUnreadableError('a line is not a JSON object');
    }
    const record = raw as Record<string, unknown>;
    if (isDelivery(record)) deliveries.push(readDelivery(record));
    else injections.push(readInjection(record));
  }
  return { injections, deliveries };
}

/**
 * When the injection at this index was delivered, or null.
 *
 * The first mark that reaches past it is the one that delivered it: marks only
 * ever move forward, and a session takes every undelivered line, so the
 * earliest mark covering an index is the moment that index reached a prompt.
 */
function deliveredAt(index: number, deliveries: readonly OnDiskDelivery[]): string | null {
  for (const delivery of deliveries) {
    if (delivery.delivered_through > index) return delivery.at;
  }
  return null;
}

/** Appends one injection. Never reads, never rewrites, never truncates. */
export function appendInbox(root: string, text: string, writtenAt: string): InboxLine {
  ensureRunDir(root);
  const record: OnDiskInjection = { text, written_at: writtenAt };
  appendJsonLine(wardroomPaths(root).inboxFile, record);
  return { text, writtenAt, deliveredAt: null };
}

/**
 * Every injection, oldest first, with the delivery the marks imply.
 *
 * An absent file is an empty inbox, not an error: a repository nobody has said
 * anything to has nothing to read.
 */
export function readInbox(root: string): InboxLine[] {
  const { injections, deliveries } = records(root);
  return injections.map((injection, index) => ({
    text: injection.text,
    writtenAt: injection.written_at,
    deliveredAt: deliveredAt(index, deliveries),
  }));
}

/** The lines no session has been given yet, oldest first. */
export function undelivered(root: string): InboxLine[] {
  return readInbox(root).filter((line) => line.deliveredAt === null);
}

/**
 * Hands every undelivered line to a caller and records that it did.
 *
 * One operation rather than a read and a separate mark, because the two are
 * one fact: D-108 marks the lines delivered at the moment the prompt is built,
 * and a caller that could read without marking would be a caller that can
 * deliver the owner's note twice.
 *
 * Nothing is appended where nothing was waiting. A mark for an empty delivery
 * would put a record in the file for something that did not happen, and
 * `history.log` shows this file to the owner.
 */
export function takeUndelivered(root: string, at: string): InboxLine[] {
  const { injections, deliveries } = records(root);
  const taken: InboxLine[] = [];
  injections.forEach((injection, index) => {
    if (deliveredAt(index, deliveries) !== null) return;
    taken.push({ text: injection.text, writtenAt: injection.written_at, deliveredAt: at });
  });

  if (taken.length === 0) return [];

  ensureRunDir(root);
  // Through the count of injections read, not through the count taken: the
  // mark is a position in the file, and an injection that arrives between the
  // read above and the append below lands after it and waits for the next
  // session rather than being skipped.
  const record: OnDiskDelivery = { delivered_through: injections.length, at };
  appendJsonLine(wardroomPaths(root).inboxFile, record);
  return taken;
}
