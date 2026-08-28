import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateShow } from '../../src/api/gates.js';
import { projectRun } from '../../src/api/project.js';
import { runCli } from '../../src/cli/main.js';
import { GateNotFoundError } from '../../src/gates/queue.js';
import type { QueryFn } from '../../src/roles/assembly.js';
import {
  GATE_ID,
  gateEntry,
  given,
  makeProject,
  writeGateEntry,
  writeProgress,
} from './support.js';

/**
 * The two signatures §5.1's table got wrong (D-111).
 *
 * Both were corrected in code before they were corrected in the table, so what
 * this file adds is not the behaviour but the check: a signature nothing tests
 * is a signature that drifts back the next time somebody finds it inconvenient,
 * and both of these are load-bearing for a reason a reader cannot see from the
 * shape alone.
 */

let root: string;

const query: QueryFn = () =>
  (async function* () {
    // A seam that answers nothing: enough to prove a call reached the loop and
    // never the live API (D-85).
  })() as never;

const REPO_ROOT = resolve(import.meta.dirname, '../..');

beforeEach(() => {
  root = makeProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('gate.show takes a project as well as an identifier (D-111)', () => {
  it('answers for the project it was given', () => {
    writeGateEntry(root, gateEntry());
    given(root);

    expect(gateShow(root, GATE_ID).what).toBe('Push 3 commits to origin/main');
  });

  it('keeps two projects holding the same identifier apart', () => {
    // The reason for the signature, and the thing an identifier alone cannot
    // do. Entries live in one project's `run/gates/` and there is no registry
    // to search, so a `gate.show(gate_id)` would have had to guess which
    // repository the owner meant.
    const other = makeProject();
    try {
      writeGateEntry(root, gateEntry({ what: 'Push 3 commits to origin/main' }));
      writeGateEntry(other, gateEntry({ what: 'Deploy to production' }));
      given(root);
      given(other);

      expect(gateShow(root, GATE_ID).what).toBe('Push 3 commits to origin/main');
      expect(gateShow(other, GATE_ID).what).toBe('Deploy to production');
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('reports an identifier this project does not hold, rather than searching elsewhere', () => {
    const other = makeProject();
    try {
      writeGateEntry(other, gateEntry());
      given(root);

      expect(() => gateShow(root, GATE_ID)).toThrow(GateNotFoundError);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('project.run takes the SDK seam as a required parameter (D-85, D-111)', () => {
  it('drives a cycle with the seam it was handed', async () => {
    writeProgress(root, null);
    given(root, { state: 'IDLE' });

    const outcome = await projectRun(root, { query });

    expect(outcome.visited[0]).toBe('IDLE');
  });

  it('refuses rather than reaching for a default where a caller omits it', async () => {
    // TypeScript refuses this at compile time, which is the first line. This
    // is the second: a JavaScript caller, or a caller that built its input
    // dynamically, must not find a module-level default waiting for it, and
    // there is none to find.
    writeProgress(root, null);
    given(root, { state: 'IDLE' });

    await expect(
      (projectRun as unknown as (root: string, input: Record<string, unknown>) => Promise<unknown>)(
        root,
        {},
      ),
    ).rejects.toThrow();
  });

  it('is refused by the CLI with the reason, rather than by a stack trace', async () => {
    given(root, { state: 'IDLE' });

    const result = await runCli(['run'], { cwd: root });

    expect(result.exitCode).toBe(1);
    expect(result.err.join('\n')).toMatch(/D-85/);
  });

  it('threads the seam the caller gave the CLI all the way through', async () => {
    // The whole chain in one case: the entry point supplies it, the CLI passes
    // it, and the loop opens sessions with it. A seam that stopped at the CLI
    // would leave the loop with nothing, which is the shape a default hides.
    writeProgress(root, null);
    // A clean tree, so the cycle reaches planning rather than stopping at the
    // dirty-tree gate a tour open raises (D-36): what is under test here is
    // the seam arriving, and a gate would answer before it was ever asked for.
    execFileSync('git', ['add', '-A'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'no tour open'], { cwd: root });
    given(root, { state: 'IDLE' });
    let opened = 0;
    const counted: QueryFn = (...args) => {
      opened += 1;
      return query(...args);
    };

    await runCli(['run'], { cwd: root, query: counted });

    expect(opened).toBeGreaterThan(0);
  });
});

describe('the seam is constructed in bin/ and nowhere else', () => {
  /** Every tracked TypeScript file under `src/`, from git rather than a glob. */
  function trackedSources(): string[] {
    return execFileSync('git', ['ls-files', '-z', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.endsWith('.ts'));
  }

  it('has the entry point import the SDK and hand it to the CLI', () => {
    // `tests/repository/sdk-seam.test.ts` says no module under `src/` imports
    // the SDK's runtime, which is what makes a default impossible rather than
    // merely absent. This is the other half: something has to supply the real
    // one, and this is the one file that does.
    const entry = readFileSync(resolve(REPO_ROOT, 'bin/wardroom.mjs'), 'utf8');

    expect(entry).toMatch(/import \{ query \} from '@anthropic-ai\/claude-agent-sdk'/);
    expect(entry).toMatch(/runCli\(.*\{ cwd: process\.cwd\(\), query \}\)/s);
  });

  it('finds no source under src/ that names the SDK as a value', () => {
    // Stated again from this side, because the two tests fail differently: the
    // seam test catches an import, and this catches a source that reached the
    // package by any other spelling.
    const offenders = trackedSources().filter((path) => {
      const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      return /require\(['"]@anthropic-ai\/claude-agent-sdk|await import\(['"]@anthropic-ai/.test(
        source,
      );
    });

    expect(offenders).toEqual([]);
  });
});
