import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATION_NAMES, UNIMPLEMENTED_OPERATIONS, operations } from '../../src/api/operations.js';
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
 * The internal API is one surface-agnostic operation set (SDD §5.1, FR-5.1).
 *
 * Every case below drives an operation with no surface present at all: no
 * terminal, no argument parsing, no formatting. That is the whole of what
 * FR-5.1 asks for, and it is checkable only if it is checked this way, since
 * an operation that quietly assumed a CLI would still pass a test that went
 * through one.
 */

let root: string;

beforeEach(() => {
  root = makeProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** Every tracked TypeScript file under `src/`, from git rather than a glob. */
function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '-z', 'src'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => path.endsWith('.ts'));
}

describe('the operation set matches the table it is specified by', () => {
  it('carries every name in §5.1, implemented or named as missing', () => {
    const covered = new Set([...Object.keys(operations), ...Object.keys(UNIMPLEMENTED_OPERATIONS)]);

    expect([...OPERATION_NAMES].filter((name) => !covered.has(name))).toEqual([]);
  });

  it('claims no operation the table does not name', () => {
    const named = new Set<string>(OPERATION_NAMES);

    expect(Object.keys(operations).filter((name) => !named.has(name))).toEqual([]);
  });

  it('offers every implemented operation as a function', () => {
    for (const [name, operation] of Object.entries(operations)) {
      expect(typeof operation, name).toBe('function');
    }
  });

  it('gives a reason for the operation it does not carry', () => {
    // kickoff has no procedure section yet (SDD §4.7), so there is nothing to
    // implement it from. Named rather than silently absent: a surface reading
    // this can say why a command is missing instead of behaving as though the
    // operation had never been specified.
    expect(Object.keys(UNIMPLEMENTED_OPERATIONS)).toEqual(['project.kickoff']);
    expect(UNIMPLEMENTED_OPERATIONS['project.kickoff']).toMatch(/4\.7/);
  });

  it('takes a project path as the first argument of every operation', () => {
    // Not a working directory, not an ambient default, not a remembered last
    // project: a command acting on a project the owner did not name is the
    // shape every destructive accident in a multi-project setup takes (D-109).
    for (const [name, operation] of Object.entries(operations)) {
      expect((operation as (...args: unknown[]) => unknown).length, name).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('no operation writes to a terminal (FR-5.1)', () => {
  it('finds no console or process stream use anywhere under src/', () => {
    // An operation that printed would work on one surface and be invisible or
    // corrupting on every other, which is FR-5.1 broken from the inside. The
    // rule is stated over the whole of `src/` rather than over `src/api/`,
    // because an operation reaches further than its own file and a helper that
    // printed would be exactly as wrong.
    const offenders: string[] = [];
    for (const path of trackedSources()) {
      const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      source.split('\n').forEach((line, index) => {
        if (/\bconsole\.\w|\bprocess\.(stdout|stderr)\b|\bprocess\.exit\b/.test(line)) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it('scans a file set that is neither empty nor a single file', () => {
    // Without this, a broken `git ls-files` call would make the rule above
    // pass by scanning nothing, which is the silent pass this project treats
    // as the worst failure mode of any check.
    expect(trackedSources().length).toBeGreaterThan(20);
  });

  it('recognises the shapes it exists to catch', () => {
    const pattern = /\bconsole\.\w|\bprocess\.(stdout|stderr)\b|\bprocess\.exit\b/;

    expect(pattern.test('console.log("x");')).toBe(true);
    expect(pattern.test('process.stdout.write("x");')).toBe(true);
    expect(pattern.test('process.exit(1);')).toBe(true);
    expect(pattern.test('const consoleWidth = 80;')).toBe(false);
  });
});

describe('each operation runs with no surface present', () => {
  /** A seam that answers nothing, so `run` reaches the loop and never the API. */
  const query: QueryFn = () =>
    (async function* () {
      // An empty session: the drive gets no result and the cycle exits on it.
    })() as never;

  it('drives project.status', () => {
    writeProgress(root);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    const status = operations['project.status'](root);

    expect(status.state).toBe('EXECUTING');
  });

  it('drives project.detach', () => {
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    expect(operations['project.detach'](root).kind).toBe('requested');
  });

  it('drives project.run', async () => {
    writeProgress(root, null);
    given(root, { state: 'IDLE' });

    const outcome = await operations['project.run'](root, { query });

    // What matters here is that the operation ran at all with nothing but a
    // path and a seam: no terminal, no arguments, no formatting.
    expect(outcome.kind).toBeDefined();
    expect(outcome.visited[0]).toBe('IDLE');
  });

  it('drives gate.list, gate.show and gate.decide', () => {
    writeGateEntry(root, gateEntry());

    expect(operations['gate.list'](root)).toHaveLength(1);
    expect(operations['gate.show'](root, GATE_ID).gateClass).toBe('push');
    const decided = operations['gate.decide'](root, GATE_ID, {
      decision: 'approved',
      note: 'go ahead',
      now: new Date('2026-08-21T10:00:00.000Z'),
    });
    expect(decided.status).toBe('approved');
    expect(operations['gate.list'](root)).toEqual([]);
  });

  it('drives decision.inject', () => {
    const line = operations['decision.inject'](root, 'the pilot repo moved', {
      now: new Date('2026-08-21T10:00:00.000Z'),
    });

    expect(line.text).toBe('the pilot repo moved');
    expect(line.deliveredAt).toBeNull();
  });

  it('drives usage.report', () => {
    expect(operations['usage.report'](root).tourId).toBeNull();
  });

  it('drives history.log', () => {
    expect(operations['history.log'](root).audit).toEqual([]);
  });

  it('drives config.show', () => {
    // FR-1.5: the green definition is what the owner asks this for.
    expect(operations['config.show'](root).verify).toEqual(['true']);
  });
});
