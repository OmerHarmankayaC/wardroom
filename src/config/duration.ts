/**
 * The `gate_wait` duration grammar (SRS §3.1, BACKLOG D-22, B-10).
 *
 * A positive whole number and one unit suffix. No compound forms: `24h`, not
 * `1d12h`. The field is written by hand in a human-edited file, so a readable
 * duration beats a seconds integer, and the single-unit restriction keeps both
 * the parser and its error messages obvious. Compound durations were rejected
 * as more parser and more error surface for a case nobody has.
 */

export const DURATION_UNITS = ['s', 'm', 'h', 'd'] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

export interface Duration {
  readonly value: number;
  readonly unit: DurationUnit;
  readonly milliseconds: number;
}

/** Stated in one place so the loader's refusal and this module cannot drift. */
export const DURATION_GRAMMAR =
  'a positive whole number followed by one unit, s, m, h or d, with no compound forms: `24h`, not `1d12h`';

const MILLISECONDS: Record<DurationUnit, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const GRAMMAR = /^([1-9][0-9]*)(s|m|h|d)$/;

/**
 * Parses a duration, or returns null when the text does not hold to the
 * grammar. Null rather than a throw, because the config loader collects every
 * problem before reporting any of them.
 */
export function parseDuration(text: unknown): Duration | null {
  if (typeof text !== 'string') return null;

  const match = GRAMMAR.exec(text);
  if (match === null) return null;

  const value = Number(match[1]);
  const unit = match[2] as DurationUnit;
  return { value, unit, milliseconds: value * MILLISECONDS[unit] };
}
