/**
 * The shape checks every module that reads a file off disk needs.
 *
 * They live here because there were three copies of the first one before this
 * file existed, in the config loader, the preview contract and the entry
 * store. Small guards get rewritten locally because importing feels heavy, and
 * then they drift: the third copy is written the same week the first one gets
 * a fix.
 */

/** A JSON object, as opposed to an array, a primitive, or null. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A string with something in it. Blank is treated as absent, never as a value. */
export function isFilledString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
