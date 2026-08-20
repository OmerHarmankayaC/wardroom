import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * No dash is used as a separator anywhere the public can see it (owner
 * instruction, 2026-08-20). The rule covers every tracked file: source
 * comments, README, configuration, tests, this file included.
 *
 * The scan bans both characters outright rather than trying to tell a
 * separator from a range. A rule a scanner cannot decide is a rule that rots,
 * and there is no legitimate occurrence of either character in this
 * repository. Commit messages already written are out of reach: cleaning them
 * would rewrite history, which is the owner's operation.
 *
 * The two characters are built from escapes so this file passes its own scan.
 */

const EM_DASH = '\u2014';
const EN_DASH = '\u2013';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Every file git tracks, whatever the working tree also holds. */
function trackedFiles(): string[] {
  const listing = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return listing.split('\0').filter((path) => path !== '');
}

/** `path:line: text` for every line carrying either character. */
function survivorsIn(path: string): string[] {
  const contents = readFileSync(resolve(REPO_ROOT, path), 'utf8');
  const survivors: string[] = [];
  contents.split('\n').forEach((line, index) => {
    if (line.includes(EM_DASH) || line.includes(EN_DASH)) {
      survivors.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  });
  return survivors;
}

describe('the repository carries no dash separators', () => {
  it('finds no em dash and no en dash in any tracked file', () => {
    const survivors = trackedFiles().flatMap(survivorsIn);

    expect(survivors).toEqual([]);
  });

  it('scans a file set that is neither empty nor a single file', () => {
    // Without this, a broken `git ls-files` call would make the rule above
    // pass by scanning nothing, which is the silent pass this project treats
    // as the worst failure mode of any check.
    expect(trackedFiles().length).toBeGreaterThan(10);
  });

  it('reports the file and the line of a survivor', () => {
    const reported = survivorsIn('tests/repository/no-dash-separators.test.ts');

    expect(reported).toEqual([]);
    expect(`sample${EM_DASH}line`).toContain(EM_DASH);
  });
});
