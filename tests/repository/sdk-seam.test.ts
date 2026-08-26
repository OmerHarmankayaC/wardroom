import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The SDK sits behind one seam, and nothing reaches past it (SDD §2, D-85).
 *
 * A criterion that needs a paid external call is a criterion that quietly
 * stops being checked: it cannot run in CI, it costs the owner's quota, and
 * under subscription auth it competes with the owner's own usage (D-46). So
 * `query` is a parameter all the way down, and a session with no seam is
 * refused rather than defaulted to the real one.
 *
 * That rule holds by construction only while nothing imports the SDK's runtime
 * exports. This is what says so: every import of the package in `src/` is a
 * type-only import, which erases at compile time and cannot call anything.
 *
 * It is checked over the tracked files rather than over a list written here,
 * for the reason the dash sweep is: a file added without its check is a file
 * the rule stopped covering.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SDK = '@anthropic-ai/claude-agent-sdk';

/** Every tracked TypeScript file under `src/`, from git rather than a glob. */
function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.endsWith('.ts'));
}

/** The import statements naming the SDK, one entry per statement. */
function sdkImports(source: string): string[] {
  const found: string[] = [];
  // Import statements can span lines, so the match runs over the whole file
  // rather than line by line, which is how the type-only marker gets missed.
  for (const match of source.matchAll(/import\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
    if (match[2] === SDK) found.push(match[0]);
  }
  return found;
}

describe('the SDK is imported for its types and never for its runtime', () => {
  const sources = trackedSources();

  it('has sources to check, so a passing run is not an empty one', () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it('imports the package type-only wherever it imports it at all', () => {
    const offenders: string[] = [];
    for (const path of sources) {
      const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      for (const statement of sdkImports(source)) {
        if (!/^import\s+type\b/.test(statement)) offenders.push(`${path}: ${statement}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('fails on a value import, so the check is not vacuous', () => {
    // Run against the shape it exists to catch, because a matcher that
    // answered "no offenders" for everything would pass the case above while
    // checking nothing.
    const mutant = `import { query } from '${SDK}';\n`;

    expect(sdkImports(mutant)).toHaveLength(1);
    expect(/^import\s+type\b/.test(sdkImports(mutant)[0] as string)).toBe(false);
  });

  it('still recognises the type-only form it accepts', () => {
    const accepted = `import type { Options } from '${SDK}';\n`;

    expect(/^import\s+type\b/.test(sdkImports(accepted)[0] as string)).toBe(true);
  });
});
