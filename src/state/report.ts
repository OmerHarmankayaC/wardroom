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

/** A deviation from the tour prompt, graded by TD-4. */
export interface ReportedDeviation {
  readonly what: string;
  /**
   * TD-4's two grades. Small is an implementation detail, applied and
   * reported; large is anything touching a requirement, a contract or an
   * acceptance criterion, and stops the tour. Borderline resolves as large.
   */
  readonly grade: DeviationGrade;
  readonly rationale: string;
}

export const DEVIATION_GRADES = ['small', 'large'] as const;
export type DeviationGrade = (typeof DEVIATION_GRADES)[number];

/** One finding from the failure-pattern audit run against the tour's diff. */
export interface ReportedFinding {
  /** Which pattern it is, in the session's own words. */
  readonly pattern: string;
  readonly finding: string;
}

export interface ClosingReport {
  readonly tourId: string;
  /** Commits the session claims it made. Checked against `.git` at closure. */
  readonly commits: readonly string[];
  /** Whether the session claims the work was pushed. Checked against the remote. */
  readonly pushed: boolean;
  readonly jobs: readonly ReportedJob[];
  readonly deviations: readonly ReportedDeviation[];
  readonly debts: readonly ReportedDebt[];
  readonly auditFindings: readonly ReportedFinding[];
  readonly notes: string;
}

/**
 * The five parts D-82 names, in the order they are rendered.
 *
 * As data, so the reader's presence check and the writer's layout cannot drift
 * apart: a part added to the report without its check is a part that can go
 * missing silently, which is the failure the check exists for.
 */
export const REPORT_PARTS = [
  'Claims',
  'Jobs',
  'Deviations',
  'Document debts',
  'Audit findings',
] as const;

export function reportPath(root: string, tourId: string): string {
  return join(wardroomPaths(root).reportsDir, `${tourId}.md`);
}

/**
 * How an aborted record announces itself, so a report reader cannot take it
 * for one (D-88).
 *
 * Its home is here, beside the report it is not, because two things need it:
 * the session consumer writes it and closure has to tell it apart from a
 * report and from no file at all (§4.6 step 1). A second copy would be a
 * second answer to "is this a report".
 */
export const ABORTED_HEADING = '# Session aborted';

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
    '## Deviations',
    '',
    '| What | Grade | Rationale |',
    '|---|---|---|',
    ...report.deviations.map(
      (deviation) =>
        `| ${cell(deviation.what)} | ${deviation.grade} | ${cell(deviation.rationale)} |`,
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
    '## Audit findings',
    '',
    '| Pattern | Finding |',
    '|---|---|',
    ...report.auditFindings.map(
      (finding) => `| ${cell(finding.pattern)} | ${cell(finding.finding)} |`,
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
 * What the report path holds (SDD §4.6 step 1, D-88, D-98).
 *
 * Three cases and not two, because closure acts differently on each. A report
 * is read; an aborted record means the tour did not finish and `CLOSING` is
 * not the state that should have been reached, so closure stops; and no file
 * at all is what a death between the generator completing and the write
 * leaves, with every acceptance criterion passing, which closure continues
 * through with the report recorded as lost.
 */
export type ReportFile =
  | { readonly kind: 'report'; readonly report: ClosingReport }
  | { readonly kind: 'aborted'; readonly text: string }
  | { readonly kind: 'lost' };

export function readReportFile(root: string, tourId: string): ReportFile {
  let text: string;
  try {
    text = readFileSync(reportPath(root, tourId), 'utf8');
  } catch {
    return { kind: 'lost' };
  }
  if (text.trimStart().startsWith(ABORTED_HEADING)) return { kind: 'aborted', text };
  return { kind: 'report', report: readReport(root, tourId) as ClosingReport };
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
  // Every part D-82 names, checked for presence before anything is read out
  // of it. A missing section and an empty one are different facts and only one
  // of them is a report: a section read as empty because it was not there
  // passes every check by having nothing to check, and a debt that went
  // missing this way is a debt nobody settles. An empty section is written by
  // rendering its header with no rows, so saying "none" stays available.
  for (const part of REPORT_PARTS) {
    if (!new RegExp(`^## ${part}\\s*$`, 'm').test(text)) {
      throw new ReportSchemaError(
        tourId,
        `it carries no ${part} section. The Implementer owes all ${REPORT_PARTS.length} parts (${REPORT_PARTS.join(', ')}); a part that is absent is reported as missing and never read as empty (SDD §4.2, D-82)`,
      );
    }
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
    deviations: rows(text, 'Deviations').map((row) => ({
      what: row[0] ?? '',
      // Anything that is not `small` is read as large. TD-4 resolves borderline
      // cases as large, and an unreadable grade is the most borderline case
      // there is: a needless gate is cheaper than a deviation that skipped one.
      grade: row[1] === 'small' ? 'small' : 'large',
      rationale: row[2] ?? '',
    })),
    debts: rows(text, 'Document debts').map((row) => ({
      document: row[0] ?? '',
      section: row[1] ?? '',
      problem: row[2] ?? '',
      settleable: row[3] === 'yes',
    })),
    auditFindings: rows(text, 'Audit findings').map((row) => ({
      pattern: row[0] ?? '',
      finding: row[1] ?? '',
    })),
    notes: notes === null ? '' : text.slice(notes.index + notes[0].length).trim(),
  };
}
