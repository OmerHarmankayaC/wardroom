import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/schema.js';
import { tourLogDirectory } from '../documents/set.js';
import { atomicWriteFile } from '../fs/atomic.js';
import type { TourJob } from '../progress/open-tour.js';

/**
 * Where a closed tour's permanent record goes, and where a carried tour's
 * unfinished jobs go (SDD §4.6 steps 4 and 5, SRS §3.2).
 *
 * The tour log is the permanent record and the open-tour block is not: the
 * block is cleared at every closure, and a tour whose only trace was the block
 * would leave nothing behind at all.
 */

/** `<doc_root>/tours/<tour_id>.md`, the one home for a tour's closure record. */
export function tourLogPath(root: string, config: ProjectConfig, tourId: string): string {
  return join(root, config.docRoot, tourLogDirectory(), `${tourId}.md`);
}

const PENDING_HEADING = /^## Pending\s*$/m;

/**
 * Writes a carried tour's unfinished jobs into PROGRESS's Pending section,
 * which is where the successor's planning reads them (§4.1, §4.6 step 5).
 *
 * Appended rather than replacing the section: Pending is the owner's list as
 * much as Wardroom's, and a closure that overwrote it would delete whatever
 * else was waiting there.
 */
export function appendPending(
  root: string,
  config: ProjectConfig,
  tourId: string,
  jobs: readonly TourJob[],
): void {
  if (jobs.length === 0) return;

  const path = join(root, config.docRoot, 'PROGRESS.md');
  const text = readFileSync(path, 'utf8');
  const heading = PENDING_HEADING.exec(text);
  if (heading === null) {
    throw new Error(
      `${path} carries no Pending section, and a carried tour's unfinished jobs are written there for the successor to plan from (SDD §4.6 step 5, D-66).`,
    );
  }

  const at = heading.index + heading[0].length;
  const lines = [
    '',
    '',
    `- Carried from ${tourId}, unfinished:`,
    ...jobs.map((job) => `  - ${job.title}: ${job.criterion}`),
  ].join('\n');

  atomicWriteFile(path, `${text.slice(0, at)}${lines}${text.slice(at)}`);
}
