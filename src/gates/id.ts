import { randomBytes } from 'node:crypto';

/**
 * Gate identifier generation (BACKLOG D-28).
 *
 * The identifier is also the entry's filename and the audit log's join key, so
 * it must be filename-safe and stable. A UTC timestamp sorts the gates
 * directory into the order the gates were raised, which is the order an owner
 * wants to read them in, and four hex characters remove the same-second
 * collision without any coordination.
 *
 * A counter was rejected: it needs either a second piece of durable state,
 * which is a new failure mode at exactly the moment the process dies, or a
 * scan of the gates directory, which stops being correct as soon as any entry
 * leaves it (D-29 defers that day rather than ruling it out).
 */

export const GATE_ID_PATTERN = /^g-\d{8}T\d{6}Z-[0-9a-f]{4}$/;

/** `YYYYMMDDTHHMMSSZ`, the compact UTC form the filename sorts on. */
function compactTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Mints an identifier for a gate being enqueued now. `randomHex` is injected
 * only by tests that need a known filename; nothing in the product passes it.
 */
export function mintGateId(now: Date, randomHex: () => string = defaultRandomHex): string {
  return `g-${compactTimestamp(now)}-${randomHex()}`;
}

function defaultRandomHex(): string {
  return randomBytes(2).toString('hex');
}
