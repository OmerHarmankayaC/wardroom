import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../fs/atomic.js';

/**
 * The open-tour block in PROGRESS (SRS §3.5, BACKLOG D-37): the tour's
 * durable record. The job list handed to the Implementer dies with the
 * process, so everything resumption needs, the jobs, their acceptance
 * criteria and their statuses, lives here and is what the resume cross-check
 * reads (SDD §4.4 step 2, FR-1.2).
 *
 * A block that fails to parse is reported with the failing field and is never
 * guessed at. When no tour is open the section states so and holds nothing
 * else.
 */

/** The three job statuses SRS §3.5 allows, updated at every job boundary. */
export const JOB_STATUSES = ['pending', 'in-progress', 'done'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export interface TourJob {
  readonly title: string;
  readonly criterion: string;
  readonly status: JobStatus;
}

export interface OpenTourBlock {
  /** The monotonic per-project identifier, `tour-` prefix included (SRS §3.3). */
  readonly tourId: string;
  readonly goal: string;
  /** The document versions the tour was planned against. */
  readonly basedOn: string;
  readonly opened: string;
  readonly jobs: readonly TourJob[];
  readonly doNotTouch: string;
  readonly stopConditions: string;
}

/**
 * What the Open tour section holds when no tour is open. The section states
 * so and holds nothing else (SRS §3.5), so a reader is never left telling an
 * empty section from a section somebody forgot to write.
 */
export const NO_OPEN_TOUR_STATEMENT = 'No tour is open.';

/**
 * What a read found. `none` is an answer, not a failure; `malformed` names
 * the failing field, because a block resumption depends on is never guessed
 * at (SRS §3.5).
 */
export type OpenTourRead =
  | { readonly kind: 'open'; readonly block: OpenTourBlock }
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed'; readonly field: string; readonly problem: string };

const TABLE_HEADER = '| # | Job | Acceptance criterion | Status |';
const TABLE_DELIMITER = '|---|---|---|---|';

/** A literal `|` inside a cell is escaped so it cannot masquerade as a border. */
function escapeCell(text: string): string {
  return text.replaceAll('|', '\\|');
}

function unescapeCell(text: string): string {
  return text.replaceAll('\\|', '|').trim();
}

/** Splits a table row on its unescaped pipes. */
function cells(row: string): string[] {
  return row.split(/(?<!\\)\|/).slice(1, -1);
}

export function renderOpenTourBlock(block: OpenTourBlock): string {
  const rows = block.jobs.map(
    (job, index) =>
      `| ${index + 1} | ${escapeCell(job.title)} | ${escapeCell(job.criterion)} | ${job.status} |`,
  );
  return [
    `### Tour ${block.tourId}`,
    '',
    `- **Goal:** ${block.goal}`,
    `- **Based on:** ${block.basedOn}`,
    `- **Opened:** ${block.opened}`,
    '',
    TABLE_HEADER,
    TABLE_DELIMITER,
    ...rows,
    '',
    `- **Do not touch:** ${block.doNotTouch}`,
    `- **Stop conditions:** ${block.stopConditions}`,
  ].join('\n');
}

/**
 * Rejoins the wrapped lines chat writes into logical lines. A line that does
 * not start a heading, a labeled field, or a table row continues the previous
 * one; a blank line ends it.
 */
function logicalLines(text: string): string[] {
  const joined: string[] = [];
  let open = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      open = false;
      continue;
    }
    const startsNew =
      line.startsWith('###') || line.startsWith('- **') || line.trimStart().startsWith('|');
    if (!startsNew && open && joined.length > 0) {
      joined[joined.length - 1] += ` ${line.trim()}`;
      continue;
    }
    joined.push(line.trim());
    open = true;
  }
  return joined;
}

function malformed(field: string, problem: string): OpenTourRead {
  return { kind: 'malformed', field, problem };
}

/** The text after a `- **Label:**` marker, or null where no line carries it. */
function labeled(lines: readonly string[], label: string): string | null {
  const prefix = `- **${label}:**`;
  const line = lines.find((candidate) => candidate.startsWith(prefix));
  return line === undefined ? null : line.slice(prefix.length).trim();
}

interface FieldSpec {
  readonly label: string;
  readonly field: string;
}

const LABELED_FIELDS: readonly FieldSpec[] = [
  { label: 'Goal', field: 'goal' },
  { label: 'Based on', field: 'based on' },
  { label: 'Opened', field: 'opened' },
  { label: 'Do not touch', field: 'do not touch' },
  { label: 'Stop conditions', field: 'stop conditions' },
];

function parseJobs(lines: readonly string[]): readonly TourJob[] | OpenTourRead {
  const headerIndex = lines.indexOf(TABLE_HEADER);
  if (headerIndex === -1) {
    return malformed('job table', `no ${TABLE_HEADER} header found.`);
  }

  const jobs: TourJob[] = [];
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (!line.startsWith('|')) break;
    if (/^\|[\s\-|]+\|$/.test(line)) continue;

    const row = cells(line);
    const position = jobs.length + 1;
    if (row.length !== 4) {
      return malformed(
        `job ${position} row`,
        `a row carries four cells, number, job, criterion and status; this one carries ${row.length}.`,
      );
    }
    const [number, title, criterion, status] = row.map(unescapeCell) as [
      string,
      string,
      string,
      string,
    ];
    if (number !== String(position)) {
      return malformed(
        `job ${position} number`,
        `rows are numbered in order; row ${position} says ${number}.`,
      );
    }
    if (title === '') return malformed(`job ${position} title`, 'the job cell is empty.');
    if (criterion === '') {
      return malformed(`job ${position} criterion`, 'the acceptance criterion cell is empty.');
    }
    if (!(JOB_STATUSES as readonly string[]).includes(status)) {
      return malformed(
        `job ${position} status`,
        `status takes exactly ${JOB_STATUSES.join(', ')}; got ${JSON.stringify(status)}.`,
      );
    }
    jobs.push({ title, criterion, status: status as JobStatus });
  }

  if (jobs.length === 0) {
    return malformed(
      'job table',
      'the table carries no job rows, and a tour without jobs is not a tour.',
    );
  }
  return jobs;
}

/**
 * Parses one Open tour section body. The section may also hold the
 * no-open-tour statement, which is an answer of its own, never a failure.
 */
export function parseOpenTourBlock(text: string): OpenTourRead {
  if (text.trim() === NO_OPEN_TOUR_STATEMENT) return { kind: 'none' };

  const lines = logicalLines(text);

  const heading = lines.find((line) => line.startsWith('### '));
  const match = heading === undefined ? null : /^### Tour (\S+)$/.exec(heading);
  if (match === null) {
    return malformed('tour heading', 'the block opens with `### Tour <id>` (SRS §3.5).');
  }
  // SRS §3.3 fixes the identifier vocabulary as `tour-<n>`, so a heading
  // written without the prefix still names exactly one identifier.
  const suffix = match[1] as string;
  const tourId = suffix.startsWith('tour-') ? suffix : `tour-${suffix}`;

  const fields: Record<string, string> = {};
  for (const { label, field } of LABELED_FIELDS) {
    const value = labeled(lines, label);
    if (value === null) {
      return malformed(field, `no \`- **${label}:**\` line found (SRS §3.5).`);
    }
    if (value === '') return malformed(field, `the \`- **${label}:**\` line is empty.`);
    fields[field] = value;
  }

  const jobs = parseJobs(lines);
  if (!Array.isArray(jobs)) return jobs as OpenTourRead;

  return {
    kind: 'open',
    block: {
      tourId,
      goal: fields.goal as string,
      basedOn: fields['based on'] as string,
      opened: fields.opened as string,
      jobs,
      doNotTouch: fields['do not touch'] as string,
      stopConditions: fields['stop conditions'] as string,
    },
  };
}

function progressPath(root: string, docRoot: string): string {
  return join(root, docRoot, 'PROGRESS.md');
}

interface Section {
  readonly contents: string;
  /** Line index of the first line after the `## Open tour` heading. */
  readonly start: number;
  /** Line index of the next `## ` heading, or one past the last line. */
  readonly end: number;
  readonly lines: readonly string[];
}

/** Locates the Open tour section, or null where the file does not carry one. */
function findSection(contents: string): Section | null {
  const lines = contents.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === '## Open tour');
  if (headingIndex === -1) return null;
  let end = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith('## ')) {
      end = index;
      break;
    }
  }
  return { contents, start: headingIndex + 1, end, lines };
}

function readSection(root: string, docRoot: string): Section | OpenTourRead {
  let contents: string;
  try {
    contents = readFileSync(progressPath(root, docRoot), 'utf8');
  } catch {
    return malformed('PROGRESS.md', `no PROGRESS.md under ${docRoot}.`);
  }
  const section = findSection(contents);
  if (section === null) {
    return malformed('Open tour section', 'PROGRESS.md carries no `## Open tour` section.');
  }
  return section;
}

function isSection(value: Section | OpenTourRead): value is Section {
  return 'start' in value;
}

/** Reads the open tour from the PROGRESS file alone (SDD §4.4 step 2). */
export function readOpenTour(root: string, docRoot: string): OpenTourRead {
  const section = readSection(root, docRoot);
  if (!isSection(section)) return section;
  return parseOpenTourBlock(section.lines.slice(section.start, section.end).join('\n'));
}

/** Replaces the section body and writes the file atomically. */
function writeSection(root: string, docRoot: string, section: Section, body: string): void {
  const replaced = [
    ...section.lines.slice(0, section.start),
    '',
    body,
    '',
    ...section.lines.slice(section.end),
  ].join('\n');
  atomicWriteFile(progressPath(root, docRoot), replaced);
}

/**
 * Writes the block into the Open tour section, leaving every other section
 * exactly as it was. PROGRESS as a whole belongs to both roles; this writer
 * owns one section of it (SDD §4.1 step 7).
 */
export function writeOpenTour(root: string, docRoot: string, block: OpenTourBlock): void {
  const section = readSection(root, docRoot);
  if (!isSection(section)) {
    throw new Error(
      `${section.kind === 'malformed' ? section.problem : section.kind} The Open tour section is where the block lives (SRS §3.5); it is not invented here.`,
    );
  }
  writeSection(root, docRoot, section, renderOpenTourBlock(block));
}

/** Clears the section back to the statement that no tour is open (SRS §3.3). */
export function clearOpenTour(root: string, docRoot: string): void {
  const section = readSection(root, docRoot);
  if (!isSection(section)) {
    throw new Error(section.kind === 'malformed' ? section.problem : section.kind);
  }
  writeSection(root, docRoot, section, NO_OPEN_TOUR_STATEMENT);
}

/**
 * Updates one job's status at a job boundary (SDD §4.2). The edit touches
 * exactly one table row: everything else in the file, the other rows
 * included, is left byte for byte as it was.
 */
export function updateJobStatus(
  root: string,
  docRoot: string,
  jobNumber: number,
  status: JobStatus,
): void {
  const section = readSection(root, docRoot);
  if (!isSection(section)) {
    throw new Error(section.kind === 'malformed' ? section.problem : section.kind);
  }

  const parsed = parseOpenTourBlock(section.lines.slice(section.start, section.end).join('\n'));
  if (parsed.kind === 'none') {
    throw new Error('no tour is open, so there is no job whose status could move.');
  }
  if (parsed.kind === 'malformed') {
    throw new Error(`the open-tour block does not parse (${parsed.field}: ${parsed.problem})`);
  }
  if (!Number.isInteger(jobNumber) || jobNumber < 1 || jobNumber > parsed.block.jobs.length) {
    throw new Error(
      `the block carries jobs 1 to ${parsed.block.jobs.length}; there is no job ${jobNumber}.`,
    );
  }

  const lines = [...section.lines];
  const prefix = `| ${jobNumber} |`;
  for (let index = section.start; index < section.end; index += 1) {
    const line = lines[index] as string;
    if (!line.startsWith(prefix)) continue;
    lines[index] = line.replace(/\|[^|]*\|\s*$/, `| ${status} |`);
    atomicWriteFile(progressPath(root, docRoot), lines.join('\n'));
    return;
  }
  throw new Error(`no table row for job ${jobNumber} was found in the section.`);
}
