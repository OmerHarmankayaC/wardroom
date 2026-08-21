import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { wardroomPaths } from '../config/paths.js';
import { atomicWriteFile } from '../fs/atomic.js';

/**
 * The closing report (SDD §3.0, §4.6 step 1, BACKLOG D-73).
 *
 * Written by the orchestrator when the session ends, and read by closure. It
 * exists because §4.4's `CLOSING` branch has to survive a death: a report that
 * lives only in a session transcript is gone the moment the process is, and
 * the document debts it carries go with it.
 *
 * It is a record and not evidence, which is the whole reason §4.6 step 2
 * checks its claims rather than adopting them. What is stored here is
 * therefore what a session *said*, kept in a shape another process can check
 * against `.git`.
 *
 * **The grammar is fixed here and nowhere else, which is a debt.** SRS §3.5
 * fixes the open-tour block's grammar because two roles read and write it; the
 * report has the same property and no section fixes it. What follows is the
 * smallest grammar that carries what §4.6 checks, and it is reported rather
 * than left implied.
 */

export interface ReportedJob {
  readonly title: string;
  /** The session's verdict on the job, in its own words. */
  readonly verdict: string;
}

export interface ReportedDebt {
  readonly document: string;
  readonly section: string;
  readonly problem: string;
  /**
   * Whether the PM can settle it without a scope decision.
   *
   * A debt that cannot raises a `scope-change` gate at closure (§4.6 step 3,
   * D-75), so the answer decides whether the tour can reach `IDLE` at all.
   */
  readonly settleable: boolean;
}

export interface ClosingReport {
  readonly tourId: string;
  /** Commits the session claims it made. Checked against `.git` at closure. */
  readonly commits: readonly string[];
  /** Whether the session claims the work was pushed. Checked against the remote. */
  readonly pushed: boolean;
  readonly jobs: readonly ReportedJob[];
  readonly debts: readonly ReportedDebt[];
  readonly notes: string;
}

export function reportPath(root: string, tourId: string): string {
  return join(wardroomPaths(root).reportsDir, `${tourId}.md`);
}

/** How an empty list is written, so absence is readable rather than blank. */
const NONE = 'none';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** The report as markdown, in the grammar {@link readReport} parses. */
export function renderReport(report: ClosingReport): string {
  return [
    `# Tour report, ${report.tourId}`,
    '',
    '## Claims',
    '',
    `- **Commits:** ${report.commits.length === 0 ? NONE : report.commits.join(', ')}`,
    `- **Pushed:** ${report.pushed ? 'yes' : 'no'}`,
    '',
    '## Jobs',
    '',
    '| # | Job | Verdict |',
    '|---|---|---|',
    ...report.jobs.map(
      (job, index) => `| ${index + 1} | ${cell(job.title)} | ${cell(job.verdict)} |`,
    ),
    '',
    '## Document debts',
    '',
    '| Document | Section | Problem | Settleable |',
    '|---|---|---|---|',
    ...report.debts.map(
      (debt) =>
        `| ${cell(debt.document)} | ${cell(debt.section)} | ${cell(debt.problem)} | ${debt.settleable ? 'yes' : 'no'} |`,
    ),
    '',
    '## Notes',
    '',
    report.notes,
    '',
  ].join('\n');
}

export function writeReport(root: string, report: ClosingReport): void {
  // One report per tour, so the directory is created on demand rather than at
  // every run: a repository with no closed tour carries none.
  mkdirSync(wardroomPaths(root).reportsDir, { recursive: true });
  atomicWriteFile(reportPath(root, report.tourId), renderReport(report));
}

/** A report that is present but cannot be read as one. */
export class ReportSchemaError extends Error {
  constructor(tourId: string, problem: string) {
    super(`the report for ${tourId} cannot be read: ${problem} (SDD §3.0, §4.6, D-73).`);
    this.name = 'ReportSchemaError';
  }
}

function rows(text: string, heading: string): string[][] {
  const section = new RegExp(`^## ${heading}\\s*$`, 'm').exec(text);
  if (section === null) return [];
  const after = text.slice(section.index + section[0].length);
  const end = /^## /m.exec(after);
  return (end === null ? after : after.slice(0, end.index))
    .split('\n')
    .filter((line) => line.trim().startsWith('|') && !/^\s*\|[\s|:-]+\|\s*$/.test(line))
    .slice(1)
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split(/(?<!\\)\|/)
        .map((value) => value.trim().replace(/\\\|/g, '|')),
    );
}

function claim(text: string, label: string, tourId: string): string {
  const found = new RegExp(`^- \\*\\*${label}:\\*\\*\\s*(.*)$`, 'm').exec(text);
  if (found === null) {
    throw new ReportSchemaError(tourId, `the Claims section carries no ${label} line`);
  }
  return (found[1] ?? '').trim();
}

/**
 * Reads the report, or null where the tour left none.
 *
 * A report that is present and unreadable throws rather than answering null.
 * Null means the session left nothing, which closure can act on; a report it
 * could not parse read as an absent one would let closure past the check that
 * a report exists to make, with nothing to check and nothing said.
 */
export function readReport(root: string, tourId: string): ClosingReport | null {
  let text: string;
  try {
    text = readFileSync(reportPath(root, tourId), 'utf8');
  } catch {
    return null;
  }

  const heading = /^# Tour report,\s*(\S+)\s*$/m.exec(text);
  if (heading === null) {
    throw new ReportSchemaError(tourId, 'it carries no `# Tour report, <tour_id>` heading');
  }
  if (heading[1] !== tourId) {
    throw new ReportSchemaError(
      tourId,
      `its heading names ${heading[1]}, so this file is another tour's report under this one's name`,
    );
  }
  if (!/^## Claims\s*$/m.test(text)) {
    throw new ReportSchemaError(
      tourId,
      'it carries no Claims section. A report with no claims is not a report claiming nothing: closure checks the claims against `.git`, and a missing section read as an empty one would pass every check by having nothing to check',
    );
  }

  const commits = claim(text, 'Commits', tourId);
  const pushed = claim(text, 'Pushed', tourId);
  if (pushed !== 'yes' && pushed !== 'no') {
    throw new ReportSchemaError(
      tourId,
      `Pushed is ${JSON.stringify(pushed)}, and the push state is one of yes or no. Anything else is a claim closure cannot check against the remote`,
    );
  }

  const notes = /^## Notes\s*$/m.exec(text);
  return {
    tourId,
    commits:
      commits === NONE || commits === ''
        ? []
        : commits
            .split(',')
            .map((hash) => hash.trim())
            .filter((hash) => hash !== ''),
    pushed: pushed === 'yes',
    jobs: rows(text, 'Jobs').map((row) => ({ title: row[1] ?? '', verdict: row[2] ?? '' })),
    debts: rows(text, 'Document debts').map((row) => ({
      document: row[0] ?? '',
      section: row[1] ?? '',
      problem: row[2] ?? '',
      settleable: row[3] === 'yes',
    })),
    notes: notes === null ? '' : text.slice(notes.index + notes[0].length).trim(),
  };
}
