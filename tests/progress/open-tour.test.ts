import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NO_OPEN_TOUR_STATEMENT,
  type OpenTourBlock,
  clearOpenTour,
  parseOpenTourBlock,
  readOpenTour,
  renderOpenTourBlock,
  updateJobStatus,
  writeOpenTour,
} from '../../src/progress/open-tour.js';

/**
 * The open-tour block (SRS §3.5, BACKLOG D-37): the tour's durable record.
 * The job list handed to the Implementer dies with the process, so everything
 * resumption needs, the jobs, their acceptance criteria and their statuses,
 * lives here in a shape code can read (SDD §4.4 step 2, FR-1.2).
 */

const DOC_ROOT = 'internal/docs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-progress-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const block: OpenTourBlock = {
  tourId: 'tour-3-a',
  goal: 'Build everything the orchestration loop stands on.',
  basedOn: 'CHARTER 1.3, SRS 1.5, SDD 1.6, BACKLOG 1.9',
  opened: '2026-08-20',
  jobs: [
    {
      title: 'B-13: derive the version-carrying set from level',
      criterion: 'The set comes from the SRS 3.2 level table, never from the file',
      status: 'done',
    },
    {
      title: 'Open-tour block writer and reader',
      criterion: 'A written block parses back from the file alone',
      status: 'pending',
    },
  ],
  doNotTouch: 'canonical documents (always); the resume cross-check seam',
  stopConditions: 'a job contradicts a canonical document; usage or context runs low',
};

function progressAround(section: string): string {
  return [
    '# PROGRESS, example',
    '',
    '## Repo',
    '',
    '- **Path:** /somewhere',
    '',
    '## Open tour',
    '',
    section,
    '',
    '## Done',
    '',
    '- 2026-08-20, Tour 2 closed.',
    '',
  ].join('\n');
}

function writeProgress(contents: string): string {
  const path = join(root, DOC_ROOT, 'PROGRESS.md');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

describe('renderOpenTourBlock and parseOpenTourBlock', () => {
  it('round-trips the goal, versions, jobs, criteria and statuses', () => {
    const parsed = parseOpenTourBlock(renderOpenTourBlock(block));

    expect(parsed).toEqual({ kind: 'open', block });
  });

  it('parses the block from text alone, with no memory of what was written', () => {
    // The reader is what a fresh process runs after a death: nothing but the
    // file exists at that point (FR-1.2).
    const rendered = renderOpenTourBlock(block);
    const parsed = parseOpenTourBlock(`${rendered}`);

    expect(parsed.kind).toBe('open');
    if (parsed.kind !== 'open') return;
    expect(parsed.block.jobs).toHaveLength(2);
    expect(parsed.block.jobs[1]?.status).toBe('pending');
  });

  it('parses a block whose labeled fields wrap across lines, as chat writes them', () => {
    const wrapped = [
      '### Tour 3-a',
      '',
      '- **Goal:** Build everything the orchestration',
      '  loop stands on.',
      '- **Based on:** CHARTER 1.3, SRS 1.5, SDD 1.6, BACKLOG 1.9',
      '- **Opened:** 2026-08-20',
      '',
      '| # | Job | Acceptance criterion | Status |',
      '|---|---|---|---|',
      '| 1 | A job | Its criterion | pending |',
      '',
      '- **Do not touch:** canonical documents (always); the resume',
      '  cross-check seam',
      '- **Stop conditions:** usage or context runs low',
    ].join('\n');

    const parsed = parseOpenTourBlock(wrapped);

    expect(parsed.kind).toBe('open');
    if (parsed.kind !== 'open') return;
    expect(parsed.block.goal).toBe('Build everything the orchestration loop stands on.');
    expect(parsed.block.doNotTouch).toBe(
      'canonical documents (always); the resume cross-check seam',
    );
  });

  it('reads the no-open-tour statement as its own answer, not as a failure', () => {
    expect(parseOpenTourBlock(NO_OPEN_TOUR_STATEMENT)).toEqual({ kind: 'none' });
  });
});

describe('malformed blocks are reported naming the field, never guessed', () => {
  function malformed(text: string): { field: string; problem: string } {
    const parsed = parseOpenTourBlock(text);
    if (parsed.kind !== 'malformed') {
      throw new Error(`expected a malformed report, got ${parsed.kind}`);
    }
    return parsed;
  }

  it('names the tour heading when it is missing', () => {
    const rendered = renderOpenTourBlock(block).replace('### Tour tour-3-a', '### tour-3-a');

    expect(malformed(rendered).field).toBe('tour heading');
  });

  it('names the goal when it is absent', () => {
    const rendered = renderOpenTourBlock(block).replace(/- \*\*Goal:\*\*.*\n/, '');

    expect(malformed(rendered).field).toBe('goal');
  });

  it('names the goal when it is empty', () => {
    const emptied = renderOpenTourBlock({ ...block, goal: '' });

    expect(malformed(emptied).field).toBe('goal');
  });

  it('names the based-on versions when they are absent', () => {
    const rendered = renderOpenTourBlock(block).replace(/- \*\*Based on:\*\*.*\n/, '');

    expect(malformed(rendered).field).toBe('based on');
  });

  it('names the opened date when it is absent', () => {
    const rendered = renderOpenTourBlock(block).replace(/- \*\*Opened:\*\*.*\n/, '');

    expect(malformed(rendered).field).toBe('opened');
  });

  it('names the job table when the header is missing', () => {
    const rendered = renderOpenTourBlock(block).replace(
      '| # | Job | Acceptance criterion | Status |\n',
      '',
    );

    expect(malformed(rendered).field).toBe('job table');
  });

  it('names the job table when it has no rows', () => {
    expect(malformed(renderOpenTourBlock({ ...block, jobs: [] })).field).toBe('job table');
  });

  it('names the row whose status is outside the three values', () => {
    const rendered = renderOpenTourBlock(block).replace('| pending |', '| paused |');

    const report = malformed(rendered);

    expect(report.field).toBe('job 2 status');
    expect(report.problem).toContain('pending, in-progress, done');
  });

  it('names the row whose number is out of sequence', () => {
    const rendered = renderOpenTourBlock(block).replace('\n| 2 |', '\n| 7 |');

    expect(malformed(rendered).field).toBe('job 2 number');
  });

  it('names the row with a missing cell', () => {
    const rendered = renderOpenTourBlock(block).replace(
      /\| 2 \|.*\n/,
      '| 2 | a title | pending |\n',
    );

    expect(malformed(rendered).field).toBe('job 2 row');
  });

  it('names the do-not-touch list when it is absent', () => {
    const rendered = renderOpenTourBlock(block).replace(/- \*\*Do not touch:\*\*.*\n/, '');

    expect(malformed(rendered).field).toBe('do not touch');
  });

  it('names the stop conditions when they are absent', () => {
    const rendered = renderOpenTourBlock(block).replace(/- \*\*Stop conditions:\*\*.*/, '');

    expect(malformed(rendered).field).toBe('stop conditions');
  });
});

describe('readOpenTour and writeOpenTour', () => {
  it('reads the block back from the PROGRESS file alone', () => {
    writeProgress(progressAround(renderOpenTourBlock(block)));

    expect(readOpenTour(root, DOC_ROOT)).toEqual({ kind: 'open', block });
  });

  it('reads a section that states no tour is open', () => {
    writeProgress(progressAround(NO_OPEN_TOUR_STATEMENT));

    expect(readOpenTour(root, DOC_ROOT)).toEqual({ kind: 'none' });
  });

  it('reports a PROGRESS file with no Open tour section by that name', () => {
    writeProgress('# PROGRESS, example\n\n## Repo\n\n- **Path:** /somewhere\n');

    const result = readOpenTour(root, DOC_ROOT);

    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.field).toBe('Open tour section');
  });

  it('reports an absent PROGRESS file rather than inventing an empty one', () => {
    const result = readOpenTour(root, DOC_ROOT);

    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.field).toBe('PROGRESS.md');
  });

  it('writes the block into the section and leaves every other section alone', () => {
    const path = writeProgress(progressAround(NO_OPEN_TOUR_STATEMENT));

    writeOpenTour(root, DOC_ROOT, block);

    const contents = readFileSync(path, 'utf8');
    expect(readOpenTour(root, DOC_ROOT)).toEqual({ kind: 'open', block });
    expect(contents).toContain('## Repo');
    expect(contents).toContain('- **Path:** /somewhere');
    expect(contents).toContain('- 2026-08-20, Tour 2 closed.');
  });

  it('clears the section back to the no-open-tour statement', () => {
    const path = writeProgress(progressAround(renderOpenTourBlock(block)));

    clearOpenTour(root, DOC_ROOT);

    expect(readOpenTour(root, DOC_ROOT)).toEqual({ kind: 'none' });
    // The section states so and holds nothing else (SRS §3.5).
    const section = readFileSync(path, 'utf8').split('## Open tour')[1]?.split('## ')[0];
    expect(section?.trim()).toBe(NO_OPEN_TOUR_STATEMENT);
  });

  it('refuses to write over a section it cannot find', () => {
    writeProgress('# PROGRESS, example\n\n## Repo\n');

    expect(() => writeOpenTour(root, DOC_ROOT, block)).toThrow(/Open tour/);
  });
});

describe('updateJobStatus', () => {
  it('updates the named job and reads back the new status', () => {
    writeProgress(progressAround(renderOpenTourBlock(block)));

    updateJobStatus(root, DOC_ROOT, 2, 'in-progress');

    const result = readOpenTour(root, DOC_ROOT);
    expect(result.kind).toBe('open');
    if (result.kind !== 'open') return;
    expect(result.block.jobs[1]?.status).toBe('in-progress');
    expect(result.block.jobs[0]?.status).toBe('done');
  });

  it('touches exactly one line of the file', () => {
    const path = writeProgress(progressAround(renderOpenTourBlock(block)));
    const before = readFileSync(path, 'utf8').split('\n');

    updateJobStatus(root, DOC_ROOT, 2, 'done');

    const after = readFileSync(path, 'utf8').split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.filter((line, index) => line !== after[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain('| 2 |');
  });

  /**
   * The status writer and the parser must read the one table under one
   * grammar. They did not: the parser rejoined wrapped lines while the writer
   * scanned raw physical lines for a literal `| N |` prefix, so every shape
   * the parser accepted and the writer did not went wrong in silence.
   */
  describe('over the wrapped rows the parser accepts', () => {
    function wrappedRow(rows: readonly string[]): string {
      return [
        '### Tour 3-a',
        '',
        '- **Goal:** g',
        '- **Based on:** SRS 1.5',
        '- **Opened:** 2026-08-20',
        '',
        '| # | Job | Acceptance criterion | Status |',
        '|---|---|---|---|',
        ...rows,
        '',
        '- **Do not touch:** x',
        '- **Stop conditions:** y',
      ].join('\n');
    }

    it('moves the status of a row wrapped mid-criterion', () => {
      writeProgress(
        progressAround(
          wrappedRow(['| 1 | A job | A long criterion that', '  wraps here | pending |']),
        ),
      );

      updateJobStatus(root, DOC_ROOT, 1, 'done');

      const result = readOpenTour(root, DOC_ROOT);
      expect(result.kind).toBe('open');
      if (result.kind !== 'open') return;
      expect(result.block.jobs[0]?.status).toBe('done');
      expect(result.block.jobs[0]?.criterion).toBe('A long criterion that wraps here');
    });

    it('keeps the criterion when the wrap falls after its closing border', () => {
      // This shape wrote the status word into the criterion cell and left the
      // status pending: the durable record lost the acceptance criterion, the
      // one thing SDD §4.4 step 4 resumes a killed tour from.
      writeProgress(progressAround(wrappedRow(['| 1 | A job | Its criterion |', '  pending |'])));

      updateJobStatus(root, DOC_ROOT, 1, 'done');

      const result = readOpenTour(root, DOC_ROOT);
      expect(result.kind).toBe('open');
      if (result.kind !== 'open') return;
      expect(result.block.jobs[0]?.criterion).toBe('Its criterion');
      expect(result.block.jobs[0]?.status).toBe('done');
    });

    it('moves the status of a row written without padding around its pipes', () => {
      writeProgress(progressAround(wrappedRow(['|1| A job | Its criterion | pending |'])));

      updateJobStatus(root, DOC_ROOT, 1, 'done');

      const result = readOpenTour(root, DOC_ROOT);
      expect(result.kind).toBe('open');
      if (result.kind !== 'open') return;
      expect(result.block.jobs[0]?.status).toBe('done');
    });

    it('leaves every other row of a wrapped table untouched', () => {
      writeProgress(
        progressAround(
          wrappedRow([
            '| 1 | First | Its criterion | done |',
            '| 2 | Second | A criterion that',
            '  wrapped | pending |',
            '| 3 | Third | Its criterion | pending |',
          ]),
        ),
      );

      updateJobStatus(root, DOC_ROOT, 2, 'done');

      const result = readOpenTour(root, DOC_ROOT);
      expect(result.kind).toBe('open');
      if (result.kind !== 'open') return;
      expect(result.block.jobs.map((job) => job.status)).toEqual(['done', 'done', 'pending']);
      expect(result.block.jobs[2]?.criterion).toBe('Its criterion');
    });
  });

  it('refuses a job number the table does not carry', () => {
    writeProgress(progressAround(renderOpenTourBlock(block)));

    expect(() => updateJobStatus(root, DOC_ROOT, 7, 'done')).toThrow(/job 7/);
  });

  it('refuses to update a section with no open tour in it', () => {
    writeProgress(progressAround(NO_OPEN_TOUR_STATEMENT));

    expect(() => updateJobStatus(root, DOC_ROOT, 1, 'done')).toThrow(/no tour is open/i);
  });
});

/**
 * SRS §3.5: when no tour is open the section states so "and holds nothing
 * else", and a block that fails to parse is reported with the failing field,
 * "never guessed at". Both rules are about the same hazard: a section whose
 * content contradicts itself must not be resolved by picking a side.
 */
describe('a section that contradicts itself is reported, never scavenged', () => {
  it('refuses a no-open-tour statement standing next to a leftover block', () => {
    const text = [NO_OPEN_TOUR_STATEMENT, '', renderOpenTourBlock(block)].join('\n');

    const result = parseOpenTourBlock(text);

    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.field).toBe('open tour section');
  });

  it('refuses two blocks in one section rather than reading the first', () => {
    const second = renderOpenTourBlock({ ...block, tourId: 'tour-4' });
    const text = [renderOpenTourBlock(block), '', second].join('\n');

    const result = parseOpenTourBlock(text);

    expect(result.kind).toBe('malformed');
    if (result.kind !== 'malformed') return;
    expect(result.field).toBe('tour heading');
  });
});

describe('renderOpenTourBlock refuses a cell it cannot represent', () => {
  it('refuses a newline in a criterion, which would split the row', () => {
    // One row per job is the grammar. A cell holding a newline renders a row
    // across two physical lines, which does not round-trip and which the
    // status writer would then have to guess at.
    expect(() =>
      renderOpenTourBlock({
        ...block,
        jobs: [{ title: 'A job', criterion: 'first\nsecond', status: 'pending' }],
      }),
    ).toThrow(/newline/);
  });

  it('refuses a newline in a job title too', () => {
    expect(() =>
      renderOpenTourBlock({
        ...block,
        jobs: [{ title: 'A\njob', criterion: 'Its criterion', status: 'pending' }],
      }),
    ).toThrow(/newline/);
  });
});
