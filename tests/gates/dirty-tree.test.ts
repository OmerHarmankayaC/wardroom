import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import { readAuditLines } from '../../src/gates/audit.js';
import { dirtyTreeGateRequest } from '../../src/gates/dirty-tree.js';
import { GateRefusedError, enqueue } from '../../src/gates/queue.js';
import { readEntry } from '../../src/gates/store.js';
import { isWorkingTreeDirty, workingTreeChanges } from '../../src/state/git.js';

/**
 * The dirty-tree gate (SRS TD-2, FR-1.6, BACKLOG D-36). A tour must not open
 * silently over the owner's uncommitted work: the changed paths are shown, the
 * owner decides, and an empty preview is refused because an empty list means
 * the tree is clean and the gate should never have been raised (D-32).
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-dirty-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Test');
  write('README.md', '# example\n');
  write('src/kept.ts', 'export const kept = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial commit');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function write(relativePath: string, contents: string): void {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe('workingTreeChanges', () => {
  it('is empty on a clean tree', () => {
    expect(workingTreeChanges(root)).toEqual([]);
  });

  it('reports a modified file', () => {
    write('src/kept.ts', 'export const kept = 2;\n');

    expect(workingTreeChanges(root)).toEqual([{ path: 'src/kept.ts', changeType: 'modified' }]);
  });

  it('reports an untracked file as untracked, not as added', () => {
    write('notes.txt', 'scratch\n');

    expect(workingTreeChanges(root)).toEqual([{ path: 'notes.txt', changeType: 'untracked' }]);
  });

  it('reports a staged new file as added', () => {
    write('src/new.ts', 'export const fresh = 1;\n');
    git('add', 'src/new.ts');

    expect(workingTreeChanges(root)).toEqual([{ path: 'src/new.ts', changeType: 'added' }]);
  });

  it('reports a deleted file', () => {
    rmSync(join(root, 'README.md'));

    expect(workingTreeChanges(root)).toEqual([{ path: 'README.md', changeType: 'deleted' }]);
  });

  it('reports a staged rename once, under the path it now has', () => {
    renameSync(join(root, 'src/kept.ts'), join(root, 'src/renamed.ts'));
    git('add', '-A');

    expect(workingTreeChanges(root)).toEqual([{ path: 'src/renamed.ts', changeType: 'renamed' }]);
  });

  it('reports a staged copy once, as added, without misreading its source path', () => {
    // A copy entry carries the source as a second token exactly as a rename
    // does, while reporting as added. Skipping keyed off the reported type
    // would push the source path in as its own entry.
    git('config', 'status.renames', 'copies');
    write('src/kept.ts', 'export const kept = 1;\nexport const grown = 2;\n');
    git('add', 'src/kept.ts');
    git('commit', '-q', '-m', 'grow the file so the copy is detectable');
    write('src/copy.ts', 'export const kept = 1;\nexport const grown = 2;\n');
    git('add', 'src/copy.ts');
    write('src/kept.ts', 'export const kept = 1;\nexport const grown = 3;\n');
    git('add', 'src/kept.ts');

    const changes = workingTreeChanges(root);

    expect(changes.every((change) => change.path.startsWith('src/'))).toBe(true);
    expect(changes.map((change) => change.path)).not.toContain('src/kept.ts -> src/copy.ts');
    expect(changes.length).toBe(2);
  });

  it("does not count Wardroom's own runtime records (D-23)", () => {
    // The orchestrator writes the marker and gate entries as a matter of
    // course; a scan that counted them would find every tree dirty at every
    // open, and a signal that always fires carries the same information as
    // one that never does.
    write('.wardroom/run/state.json', '{}\n');

    expect(workingTreeChanges(root)).toEqual([]);
  });

  it('agrees with the cleanliness probe, because it is the same scan', () => {
    // One fact, one home: if the two ever disagreed, resume and the dirty-tree
    // gate would judge the same tree differently.
    expect(isWorkingTreeDirty(root)).toBe(workingTreeChanges(root).length > 0);

    write('notes.txt', 'scratch\n');

    expect(isWorkingTreeDirty(root)).toBe(true);
    expect(workingTreeChanges(root).length > 0).toBe(true);
  });
});

describe('dirtyTreeGateRequest', () => {
  const changes = [{ path: 'notes.txt', changeType: 'untracked' as const }];

  it('carries the pre-tour identity the SDD §3.2 note fixes', () => {
    const request = dirtyTreeGateRequest('tour-3', changes);

    // interrupted_state is IDLE because no tour exists yet; job_index is 0 for
    // the same reason; tour_id is the id the tour will carry, knowable before
    // planning because identifiers are monotonic (SRS §3.3).
    expect(request.gateClass).toBe('dirty-tree');
    expect(request.interruptedState).toBe('IDLE');
    expect(request.jobIndex).toBe(0);
    expect(request.tourId).toBe('tour-3');
  });

  it('states what is asked and the rule that classified it', () => {
    const request = dirtyTreeGateRequest('tour-3', changes);

    expect(request.what.trim()).not.toBe('');
    expect(request.why).toContain('FR-1.6');
  });

  it('round-trips through the entry store with its paths and change types', () => {
    const entry = enqueue(root, dirtyTreeGateRequest('tour-3', changes), {
      now: new Date('2026-08-20T13:15:00.000Z'),
      randomHex: () => 'a3f9',
    });

    expect(readEntry(root, entry.gateId)).toEqual(entry);
    expect(entry.preview).toEqual({ kind: 'dirty-tree', changes });
  });

  it('is refused at enqueue when the change list is empty, leaving no trace (D-32)', () => {
    expect(() => enqueue(root, dirtyTreeGateRequest('tour-3', []))).toThrow(GateRefusedError);

    // No entry file and no audit line: a refused request is not an action, and
    // an empty list means the tree is clean and the gate should not have been
    // raised at all.
    const files = readdirSync(wardroomPaths(root).gatesDir).filter((f) => f.startsWith('g-'));
    expect(files).toEqual([]);
    expect(readAuditLines(root)).toEqual([]);
  });
});
