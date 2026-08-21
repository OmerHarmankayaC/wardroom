import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append-only JSON Lines, the one mechanism Wardroom's two such records share:
 * the gate audit log (SDD §3.1) and the usage record (§3.0, D-74).
 *
 * It is deliberately the opposite of ../fs/atomic.ts, which replaces a whole
 * file. Replacing a whole file is the one thing an append-only record must
 * never do, and having both mechanisms in one repository is exactly why each
 * says in its own module which one it is.
 *
 * One home for the read as well as the write. Both records are read after a
 * process may have died mid-append, and the rule for what that leaves behind
 * is subtle enough that two copies of it would eventually differ: the first
 * one to be fixed would be the only one fixed.
 */

/** Appends one record, creating the directory on demand. Never truncates. */
export function appendJsonLine(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/**
 * Every complete record, oldest first. An absent file is an empty record, not
 * an error: a repository that has never been run has nothing to read.
 *
 * A trailing partial line is ignored rather than raised. A process killed
 * mid-append can leave one, and refusing to read the whole record because of
 * its last few bytes would lose the evidence it exists to keep. Anything else
 * unparsable is a corrupted record and is reported, naming the file and the
 * line, because that one is a defect rather than a death.
 */
export function readJsonLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }

  const complete = text.split('\n');
  // The split's last element is the text after the final newline: empty for a
  // cleanly terminated file, a partial record otherwise. Either way it is not
  // a line that was finished being written.
  complete.pop();

  return complete.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `${path} line ${index + 1} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}
