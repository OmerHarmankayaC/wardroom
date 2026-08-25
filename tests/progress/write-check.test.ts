import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type OpenTourBlock,
  appendJob,
  readOpenTour,
  renderOpenTourBlock,
  updateJobStatus,
} from '../../src/progress/open-tour.js';
import { checkProgressWrite } from '../../src/progress/write-check.js';

/**
 * What a proposed write would do to the open-tour block (SDD §4.2, D-95).
 *
 * The permission rules say which file may be written and this says what the
 * write may do to the one table inside it, because a path glob cannot express
 * the second question. The calls below are the shapes a session actually
 * makes, `Edit` with an `old_string` and a `new_string` and `Write` with a
 * whole file, so the check meets the input it will meet in a run rather than a
 * structure this suite built for it (D-55).
 */

const DOC_ROOT = 'internal/docs';

let root: string;

const block: OpenTourBlock = {
  tourId: 'tour-9',
  goal: 'Prove the guard guards.',
  basedOn: 'CHARTER 1.3, SRS 1.13, SDD 1.18, BACKLOG 1.21',
  opened: '2026-08-21',
  jobs: [
    { title: 'First job', criterion: 'the first thing holds', status: 'done' },
    { title: 'Second job', criterion: 'the second thing holds', status: 'in-progress' },
  ],
  doNotTouch: 'the CLI',
  stopConditions: 'a large deviation',
};

function progressPath(): string {
  return join(root, DOC_ROOT, 'PROGRESS.md');
}

function writeProgress(open: OpenTourBlock): void {
  const text = [
    '# PROGRESS',
    '',
    '## Open tour',
    '',
    renderOpenTourBlock(open),
    '',
    '## Done',
    '',
    'none',
    '',
  ].join('\n');
  mkdirSync(dirname(progressPath()), { recursive: true });
  writeFileSync(progressPath(), text);
}

function check(toolName: string, toolInput: unknown) {
  return checkProgressWrite({ root, docRoot: DOC_ROOT, toolName, toolInput });
}

/** An `Edit` call as the tool receives it. */
function edit(oldString: string, newString: string, path = join(DOC_ROOT, 'PROGRESS.md')) {
  return check('Edit', { file_path: path, old_string: oldString, new_string: newString });
}

function allowed(result: ReturnType<typeof check>): boolean {
  return result.kind === 'block' && result.verdict.allowed;
}

function reason(result: ReturnType<typeof check>): string {
  return result.kind === 'block' && !result.verdict.allowed ? result.verdict.reason : '';
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-write-check-'));
  writeProgress(block);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('calls that are not a write to this project PROGRESS', () => {
  it('says nothing about a shell command', () => {
    expect(check('Bash', { command: 'npm run test' }).kind).toBe('not-progress');
  });

  it('says nothing about a source file', () => {
    expect(check('Write', { file_path: 'src/index.ts', content: 'export {};' }).kind).toBe(
      'not-progress',
    );
  });

  it('says nothing about another project PROGRESS outside the document root', () => {
    expect(check('Write', { file_path: 'notes/PROGRESS.md', content: '' }).kind).toBe(
      'not-progress',
    );
  });

  it('sees an absolute path naming the same file', () => {
    expect(check('Write', { file_path: progressPath(), content: '' }).kind).toBe('block');
  });
});

describe('the two changes the Implementer may make reach the file', () => {
  it('accepts a status move written as an Edit', () => {
    const result = edit(
      '| 2 | Second job | the second thing holds | in-progress |',
      '| 2 | Second job | the second thing holds | done |',
    );

    expect(allowed(result)).toBe(true);
  });

  it('accepts a row appended after the last one', () => {
    const result = edit(
      '| 2 | Second job | the second thing holds | in-progress |',
      '| 2 | Second job | the second thing holds | in-progress |\n| 3 | Audit finding | the pattern is gone | pending |',
    );

    expect(allowed(result)).toBe(true);
    expect(result.kind === 'block' && result.verdict.allowed && result.verdict.kind).toBe('append');
  });
});

describe('the changes it may not make are refused before the write happens', () => {
  it('refuses an edit to an existing criterion', () => {
    const result = edit(
      '| 1 | First job | the first thing holds | done |',
      '| 1 | First job | something easier | done |',
    );

    expect(allowed(result)).toBe(false);
    expect(reason(result)).toMatch(/row 1/);
  });

  it('refuses a removal written as a Write of the whole file', () => {
    const result = check('Write', {
      file_path: join(DOC_ROOT, 'PROGRESS.md'),
      content: readFileSync(progressPath(), 'utf8').replace(
        '| 2 | Second job | the second thing holds | in-progress |\n',
        '',
      ),
    });

    expect(allowed(result)).toBe(false);
    expect(reason(result)).toMatch(/removes/);
  });

  it('refuses a write that touches another section by breaking the block', () => {
    const result = check('Write', {
      file_path: join(DOC_ROOT, 'PROGRESS.md'),
      content: '# PROGRESS\n\n## Open tour\n\nrewritten by hand\n',
    });

    expect(allowed(result)).toBe(false);
  });

  it('refuses a call whose effect cannot be worked out rather than waving it through', () => {
    // `old_string` matches nothing, so what the file would become is unknown.
    // Silence here would be a check reporting itself installed and answering
    // nothing, which is worse than being absent.
    const result = edit('a line that is not in the file', 'anything');

    expect(allowed(result)).toBe(false);
    expect(reason(result)).toMatch(/could not tell/);
  });

  it('refuses when PROGRESS cannot be read at all', () => {
    rmSync(progressPath());

    expect(allowed(check('Write', { file_path: join(DOC_ROOT, 'PROGRESS.md'), content: '' }))).toBe(
      false,
    );
  });
});

describe('the writers this project ships produce edits the check accepts', () => {
  /**
   * The other direction of D-55: the guard above is fed hand-written calls, and
   * these two feed it what the shipped writers actually leave on disk. Either
   * check alone would pass while the writer and the guard disagreed about the
   * same table.
   */
  it('appendJob leaves a block the guard reads as an append', () => {
    const before = readFileSync(progressPath(), 'utf8');
    appendJob(root, DOC_ROOT, {
      title: 'Audit finding',
      criterion: 'the pattern no longer appears anywhere in the tour diff',
      status: 'pending',
    });
    const after = readFileSync(progressPath(), 'utf8');

    const read = readOpenTour(root, DOC_ROOT);
    expect(read.kind === 'open' && read.block.jobs).toHaveLength(3);
    expect(read.kind === 'open' && read.block.jobs[2]?.title).toBe('Audit finding');
    // The rows above it are untouched, byte for byte.
    expect(after.startsWith(before.slice(0, before.indexOf('| 2 |')))).toBe(true);

    writeFileSync(progressPath(), before);
    expect(
      allowed(check('Write', { file_path: join(DOC_ROOT, 'PROGRESS.md'), content: after })),
    ).toBe(true);
  });

  it('updateJobStatus leaves a block the guard reads as a status move', () => {
    const before = readFileSync(progressPath(), 'utf8');
    updateJobStatus(root, DOC_ROOT, 2, 'done');
    const after = readFileSync(progressPath(), 'utf8');

    writeFileSync(progressPath(), before);
    const result = check('Write', { file_path: join(DOC_ROOT, 'PROGRESS.md'), content: after });

    expect(result.kind === 'block' && result.verdict.allowed && result.verdict.kind).toBe('status');
  });

  it('appendJob refuses where no tour is open', () => {
    writeFileSync(progressPath(), '# PROGRESS\n\n## Open tour\n\nNo tour is open.\n');

    expect(() =>
      appendJob(root, DOC_ROOT, { title: 'x', criterion: 'y', status: 'pending' }),
    ).toThrowError(/no tour is open/i);
  });
});
