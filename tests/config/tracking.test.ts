import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RUNTIME_IGNORE_ENTRY,
  applyTrackingPolicy,
  runtimeIgnoreEntries,
} from '../../src/config/tracking.js';

/**
 * BACKLOG D-15: `track_runtime: false` excludes `.wardroom/run/` and nothing
 * else. The rejected draft let one flag exclude all of `.wardroom/`, which
 * would have taken the green definition out of the repository: the failure
 * D-13 exists to prevent. These tests are what stops that draft coming back.
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wardroom-tracking-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
}

function write(relativePath: string, contents: string): void {
  const target = join(repo, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe('runtimeIgnoreEntries', () => {
  it('excludes exactly one path when runtime records are untracked', () => {
    expect(runtimeIgnoreEntries(false)).toEqual([RUNTIME_IGNORE_ENTRY]);
  });

  it('excludes nothing when runtime records are tracked', () => {
    expect(runtimeIgnoreEntries(true)).toEqual([]);
  });

  it('never excludes the configuration file', () => {
    expect(RUNTIME_IGNORE_ENTRY).toBe('.wardroom/run/');
    expect(runtimeIgnoreEntries(false)).not.toContain('.wardroom/');
    expect(runtimeIgnoreEntries(false)).not.toContain('.wardroom/config.json');
  });
});

describe('applyTrackingPolicy', () => {
  it('adds one line and removes none from a real, long ignore file', () => {
    // This repository's own ignore file, with the runtime entry taken back out
    // so the assertion holds whether or not the policy has already been applied.
    const before = readFileSync(resolve(import.meta.dirname, '../../.gitignore'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== RUNTIME_IGNORE_ENTRY)
      .join('\n');

    const after = applyTrackingPolicy(before, false);

    const added = after.split('\n').filter((line) => !before.split('\n').includes(line));
    const removed = before.split('\n').filter((line) => !after.split('\n').includes(line));
    expect(added).toEqual([RUNTIME_IGNORE_ENTRY]);
    expect(removed).toEqual([]);
  });

  it('is idempotent: a second application adds nothing', () => {
    const once = applyTrackingPolicy('node_modules/\n', false);

    expect(applyTrackingPolicy(once, false)).toBe(once);
  });

  it('leaves the ignore file untouched when runtime records are tracked', () => {
    expect(applyTrackingPolicy('node_modules/\n', true)).toBe('node_modules/\n');
  });
});

describe('a repository with track_runtime: false', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main');
    write('.gitignore', applyTrackingPolicy('node_modules/\n', false));
    write('.wardroom/config.json', '{ "name": "example" }\n');
    write('.wardroom/run/state.json', '{ "state": "IDLE" }\n');
    write('.wardroom/run/gates/audit.jsonl', '{}\n');
    write('src/index.ts', 'export {};\n');
    git('add', '-A');
  });

  it('still tracks the project contract', () => {
    expect(git('ls-files').split('\n')).toContain('.wardroom/config.json');
  });

  it('does not track any runtime record', () => {
    const tracked = git('ls-files').split('\n');

    expect(tracked.filter((path) => path.startsWith('.wardroom/run/'))).toEqual([]);
  });

  it('excludes nothing outside the runtime directory', () => {
    const tracked = git('ls-files').split('\n').filter(Boolean);

    expect(tracked.sort()).toEqual(['.gitignore', '.wardroom/config.json', 'src/index.ts']);
  });

  it('reports the runtime directory, and only it, as ignored', () => {
    const ignored = git('status', '--porcelain', '--ignored=matching')
      .split('\n')
      .filter((line) => line.startsWith('!!'))
      .map((line) => line.slice(3));

    expect(ignored.every((path) => path.startsWith('.wardroom/run/'))).toBe(true);
    expect(ignored.length).toBeGreaterThan(0);
  });
});
