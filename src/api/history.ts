import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import { tourLogDirectory } from '../documents/set.js';
import { type AuditLine, readAuditLines } from '../gates/audit.js';
import { type InboxLine, readInbox } from './inbox.js';

/**
 * The tour logs and the gate audit trail (SDD §5.1, FR-3.2).
 *
 * Two records rather than one merged stream. They answer different questions
 * and are written by different things: a tour log is the PM's permanent
 * account of a closed tour (§4.6), and the audit trail is the append-only
 * record of every gate request and decision with its timestamp, which is what
 * FR-3.2 requires. Interleaving them by time would produce a third record
 * neither of them is, and a reader could no longer tell which line came from
 * which.
 *
 * The inbox rides along because D-108 says in as many words that delivery is
 * recorded rather than the line being removed so that `history.log` can show
 * what the owner told the roles and when. Without it that sentence describes
 * nothing.
 *
 * Nothing here is parsed. A tour log is prose written for a person, and a
 * reader that imposed a grammar on it would be inventing a contract the PM was
 * never held to.
 */

export interface TourLog {
  readonly tourId: string;
  /** Repository relative, so a surface can name the file the owner can open. */
  readonly path: string;
  readonly contents: string;
}

export interface HistoryLog {
  /** Every tour log the document root holds, by tour identifier, sorted by name. */
  readonly tours: readonly TourLog[];
  /** Every gate request and decision, oldest first (FR-3.2). */
  readonly audit: readonly AuditLine[];
  /** What the owner injected, and whether it reached a session (D-108). */
  readonly inbox: readonly InboxLine[];
}

/**
 * The tour logs on disk.
 *
 * An absent directory is no tours rather than an error: a project that has
 * closed no tour has none, and a repository is not broken for having nothing
 * to show yet.
 */
function tourLogs(root: string, docRoot: string): TourLog[] {
  const relative = join(docRoot, tourLogDirectory());
  let names: string[];
  try {
    names = readdirSync(join(root, relative));
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => ({
      tourId: name.slice(0, -'.md'.length),
      path: join(relative, name),
      contents: readFileSync(join(root, relative, name), 'utf8'),
    }));
}

export function historyLog(root: string): HistoryLog {
  const config = loadConfig(root);
  return {
    tours: tourLogs(root, config.docRoot),
    audit: readAuditLines(root),
    inbox: readInbox(root),
  };
}
