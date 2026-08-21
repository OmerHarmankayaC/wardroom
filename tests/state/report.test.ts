import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';
import {
  type ClosingReport,
  readReport,
  renderReport,
  writeReport,
} from '../../src/state/report.js';

/**
 * The closing report (SDD §3.0, §4.6 step 1, D-73).
 *
 * Written by the orchestrator when the session ends, because closure reads it
 * and §4.4's `CLOSING` branch has to survive a death: a report that lives only
 * in a session transcript is gone the moment the process is, and the document
 * debts it carries go with it.
 *
 * It is a record and not evidence, which is the whole reason §4.6 checks its
 * claims rather than adopting them.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-report-'));
  ensureRunDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const report: ClosingReport = {
  tourId: 'tour-9',
  commits: ['abc1234', 'def5678'],
  pushed: false,
  jobs: [
    { title: 'First job', verdict: 'done' },
    { title: 'Second job', verdict: 'not done' },
  ],
  debts: [
    { document: 'SRS.md', section: '5.2', problem: 'the rule has no actor', settleable: true },
    { document: 'SDD.md', section: '4.6', problem: 'the order is wrong', settleable: false },
  ],
  notes: 'One deviation, small, applied.',
};

describe('the report round-trips through the file closure reads', () => {
  it('writes it where SDD §3.0 puts it', () => {
    writeReport(root, report);

    expect(readFileSync(join(wardroomPaths(root).reportsDir, 'tour-9.md'), 'utf8')).toContain(
      'tour-9',
    );
  });

  it('reads back every claim it was given', () => {
    writeReport(root, report);

    expect(readReport(root, 'tour-9')).toEqual(report);
  });

  it('keeps a report with nothing to report', () => {
    const empty: ClosingReport = {
      tourId: 'tour-1',
      commits: [],
      pushed: false,
      jobs: [],
      debts: [],
      notes: '',
    };
    writeReport(root, empty);

    expect(readReport(root, 'tour-1')).toEqual(empty);
  });

  it('answers null for a tour that left no report', () => {
    expect(readReport(root, 'tour-404')).toBeNull();
  });

  it('keeps one report per tour, so an earlier tour survives a later one', () => {
    writeReport(root, report);
    writeReport(root, { ...report, tourId: 'tour-10', commits: ['0000000'] });

    expect(readReport(root, 'tour-9')?.commits).toEqual(['abc1234', 'def5678']);
    expect(readReport(root, 'tour-10')?.commits).toEqual(['0000000']);
  });
});

describe('the reader is judged against reports it did not write', () => {
  /**
   * D-55: this job ships the writer and the reader together, so the reader is
   * exercised against markdown assembled here by hand. A round trip could not
   * see an assumption both halves share, and the assumption under test is
   * exactly what the two of them agree the grammar is.
   */
  function handWritten(body: string): void {
    mkdirSync(wardroomPaths(root).reportsDir, { recursive: true });
    writeFileSync(join(wardroomPaths(root).reportsDir, 'tour-9.md'), body);
  }

  it('reads a report written by hand in the stated grammar', () => {
    handWritten(
      [
        '# Tour report, tour-9',
        '',
        '## Claims',
        '',
        '- **Commits:** 1111111, 2222222',
        '- **Pushed:** yes',
        '',
        '## Jobs',
        '',
        '| # | Job | Verdict |',
        '|---|---|---|',
        '| 1 | Only job | done |',
        '',
        '## Document debts',
        '',
        '| Document | Section | Problem | Settleable |',
        '|---|---|---|---|',
        '| SRS.md | 1.1 | a problem | yes |',
        '',
        '## Notes',
        '',
        'nothing else',
        '',
      ].join('\n'),
    );

    expect(readReport(root, 'tour-9')).toEqual({
      tourId: 'tour-9',
      commits: ['1111111', '2222222'],
      pushed: true,
      jobs: [{ title: 'Only job', verdict: 'done' }],
      debts: [{ document: 'SRS.md', section: '1.1', problem: 'a problem', settleable: true }],
      notes: 'nothing else',
    });
  });

  it('refuses a report whose claims section is missing rather than reading none', () => {
    // A report with no claims is not a report claiming nothing. Closure checks
    // claims against `.git`, and a missing section read as an empty one would
    // pass every check by having nothing to check.
    handWritten('# Tour report, tour-9\n\n## Notes\n\nnothing\n');

    expect(() => readReport(root, 'tour-9')).toThrowError(/claims/i);
  });

  it('refuses a report that names a different tour', () => {
    handWritten('# Tour report, tour-8\n\n## Claims\n\n- **Commits:** none\n- **Pushed:** no\n');

    expect(() => readReport(root, 'tour-9')).toThrowError(/tour-8/);
  });

  it('refuses a push claim that is neither yes nor no', () => {
    handWritten(
      '# Tour report, tour-9\n\n## Claims\n\n- **Commits:** none\n- **Pushed:** partly\n',
    );

    expect(() => readReport(root, 'tour-9')).toThrowError(/Pushed/);
  });

  it('reads an explicit absence of commits rather than guessing at a blank', () => {
    handWritten('# Tour report, tour-9\n\n## Claims\n\n- **Commits:** none\n- **Pushed:** no\n');

    expect(readReport(root, 'tour-9')?.commits).toEqual([]);
  });
});

describe('the rendering is stable, so a reader can be written against it', () => {
  it('renders the same text twice for the same report', () => {
    expect(renderReport(report)).toBe(renderReport(report));
  });

  it('states the tour in its heading, which is what identifies the file', () => {
    expect(renderReport(report).split('\n')[0]).toBe('# Tour report, tour-9');
  });

  it('writes `none` rather than an empty list, so absence is readable', () => {
    expect(renderReport({ ...report, commits: [] })).toContain('- **Commits:** none');
  });
});
