import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Atomic file replacement (SDD §3.3, BACKLOG D-20).
 *
 * Serialize into a temporary file in the same directory, then rename over the
 * target. A rename within one directory is atomic, so a process killed at any
 * instant leaves either the previous contents or the new ones, never half of
 * either.
 *
 * Every durable record Wardroom replaces goes through here: the state marker
 * writes at exactly the boundaries where the process is doing something else
 * dangerous, and a gate entry is the record of a decision nobody has made yet.
 * One mechanism, one home. The append-only audit log is the deliberate
 * exception and says so in its own module: appending must never replace a
 * file, which is the one thing this function does.
 */

let writeCounter = 0;

/**
 * Replaces `target` with `contents`. The temporary name is unique per write so
 * two writers cannot land on each other's partial file, and it carries the
 * target's own name so a temporary that does survive a crash says what it was
 * on its way to becoming.
 */
export function atomicWriteFile(target: string, contents: string): void {
  const name = `.${basename(target)}.${process.pid}.${writeCounter++}.tmp`;
  const temporary = join(dirname(target), name);

  writeFileSync(temporary, contents);
  try {
    renameSync(temporary, target);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename failure is the one worth reporting.
    }
    throw error;
  }
}
