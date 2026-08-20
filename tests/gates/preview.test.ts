import { describe, expect, it } from 'vitest';
import { previewProblem } from '../../src/gates/preview.js';
import { GATE_CLASSES, type GateClass, type GatePreview } from '../../src/gates/schema.js';

/**
 * The per-class preview contract (SDD §3.1). A gate without its preview is not
 * presentable and must not be enqueued: an owner asked to approve an action
 * they cannot inspect approves it blindly, which is the failure the gate
 * exists to prevent.
 */

/** Each class mapped to its own preview member, so a test can destructure one. */
type PresentableSet = { [K in GateClass]: Extract<GatePreview, { kind: K }> };

const presentable: PresentableSet = {
  push: {
    kind: 'push',
    commits: [{ hash: 'c26560c', subject: 'style: remove dash separators' }],
    remote: 'origin',
    branch: 'main',
  },
  deployment: {
    kind: 'deployment',
    environment: 'production',
    changedServices: ['orchestrator'],
    pendingMigrations: ['0007_add_gate_index'],
  },
  'scope-change': {
    kind: 'scope-change',
    sections: [{ document: 'SRS.md', section: '5.6', diff: '-version only\n+version and hash' }],
  },
  destructive: {
    kind: 'destructive',
    command: 'git clean -fdx',
    affects: ['internal/docs/'],
  },
  secrets: {
    kind: 'secrets',
    secret: 'ANTHROPIC_API_KEY',
    access: 'read',
    purpose: 'start the Implementer session',
  },
  'tour-budget': {
    kind: 'tour-budget',
    attemptCount: 3,
    lastFailureOutput: '2 tests failed in tests/gates/queue.test.ts',
  },
  'dirty-tree': {
    kind: 'dirty-tree',
    changes: [
      { path: 'src/half.ts', changeType: 'modified' },
      { path: 'notes.txt', changeType: 'untracked' },
    ],
  },
};

describe('previewProblem', () => {
  for (const gateClass of GATE_CLASSES) {
    it(`accepts a complete ${gateClass} preview`, () => {
      expect(previewProblem(gateClass, presentable[gateClass])).toBeNull();
    });

    it(`refuses a ${gateClass} gate with no preview at all`, () => {
      const problem = previewProblem(gateClass, undefined);

      expect(problem).toContain('preview');
      expect(problem).toContain(gateClass);
    });

    it(`refuses a ${gateClass} gate carrying another class's preview`, () => {
      const other = gateClass === 'push' ? presentable.secrets : presentable.push;

      expect(previewProblem(gateClass, other)).toContain('preview.kind');
    });
  }

  it('names the missing field rather than reporting a bare failure', () => {
    const { remote: _absent, ...withoutRemote } = presentable.push;

    expect(previewProblem('push', withoutRemote)).toContain('preview.remote');
  });

  it('refuses a push preview whose commit list is empty', () => {
    const problem = previewProblem('push', { ...presentable.push, commits: [] });

    expect(problem).toContain('preview.commits');
    expect(problem).toContain('empty');
  });

  it('refuses a commit entry missing its subject', () => {
    const problem = previewProblem('push', {
      ...presentable.push,
      commits: [{ hash: 'c26560c', subject: '' }],
    });

    expect(problem).toContain('preview.commits[0]');
  });

  it('accepts a deployment with nothing pending, because that is the information', () => {
    const nothingPending = { ...presentable.deployment, pendingMigrations: [] };

    expect(previewProblem('deployment', nothingPending)).toBeNull();
  });

  it('still refuses a deployment whose pending list is absent rather than empty', () => {
    const { pendingMigrations: _absent, ...withoutMigrations } = presentable.deployment;

    expect(previewProblem('deployment', withoutMigrations)).toContain('preview.pendingMigrations');
  });

  it('refuses a deployment that changes no service', () => {
    const problem = previewProblem('deployment', {
      ...presentable.deployment,
      changedServices: [],
    });

    expect(problem).toContain('preview.changedServices');
  });

  it('refuses a scope change with no section shown', () => {
    expect(previewProblem('scope-change', { kind: 'scope-change', sections: [] })).toContain(
      'preview.sections',
    );
  });

  it('refuses a destructive gate that does not say what it affects', () => {
    const problem = previewProblem('destructive', { ...presentable.destructive, affects: [] });

    expect(problem).toContain('preview.affects');
  });

  it('refuses a secrets preview that carries the secret itself', () => {
    const problem = previewProblem('secrets', {
      ...presentable.secrets,
      value: 'sk-ant-not-a-real-key',
    });

    expect(problem).toContain('never carries the secret itself');
  });

  it('refuses a secrets preview whose access is neither read nor write', () => {
    expect(previewProblem('secrets', { ...presentable.secrets, access: 'rotate' })).toContain(
      'preview.access',
    );
  });

  it('refuses a tour-budget preview reporting no attempt', () => {
    const problem = previewProblem('tour-budget', {
      ...presentable['tour-budget'],
      attemptCount: 0,
    });

    expect(problem).toContain('preview.attemptCount');
  });

  it('refuses a dirty-tree preview with no changes, because that tree is clean (D-32)', () => {
    // An empty list means the tree is clean and the gate should not have been
    // raised: refusing catches the bug upstream rather than presenting the
    // owner with nothing to inspect.
    expect(previewProblem('dirty-tree', { kind: 'dirty-tree', changes: [] })).toContain(
      'preview.changes',
    );
  });

  it('refuses a dirty-tree change outside the five named types (D-36)', () => {
    const problem = previewProblem('dirty-tree', {
      kind: 'dirty-tree',
      changes: [{ path: 'src/half.ts', changeType: 'staged' }],
    });

    expect(problem).toContain('preview.changes[0]');
    expect(problem).toContain('modified, added, deleted, renamed, untracked');
  });

  it('refuses a dirty-tree change with no path to point at', () => {
    const problem = previewProblem('dirty-tree', {
      kind: 'dirty-tree',
      changes: [{ path: '  ', changeType: 'modified' }],
    });

    expect(problem).toContain('preview.changes[0]');
  });

  it('reports every problem at once rather than one per correction', () => {
    const problem = previewProblem('push', { kind: 'push', commits: [], remote: '', branch: '' });

    expect(problem).toContain('preview.commits');
    expect(problem).toContain('preview.remote');
    expect(problem).toContain('preview.branch');
  });

  it('refuses a class that is not a TD-2 gate class', () => {
    expect(previewProblem('rollback' as GateClass, {})).toContain('class');
  });
});
