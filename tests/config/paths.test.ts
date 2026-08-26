import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureRunDir, wardroomPaths } from '../../src/config/paths.js';

/** The layout under `.wardroom/` is fixed by SDD §3.0. */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('wardroomPaths', () => {
  it('places configuration and runtime records where SDD §3.0 puts them', () => {
    const paths = wardroomPaths(root);

    expect(paths).toEqual({
      root,
      wardroomDir: join(root, '.wardroom'),
      configFile: join(root, '.wardroom', 'config.json'),
      runDir: join(root, '.wardroom', 'run'),
      stateFile: join(root, '.wardroom', 'run', 'state.json'),
      lastFailureFile: join(root, '.wardroom', 'run', 'last-failure.json'),
      usageLog: join(root, '.wardroom', 'run', 'usage.jsonl'),
      reportsDir: join(root, '.wardroom', 'run', 'reports'),
      // Added by SDD 1.4 §3.0 (BACKLOG D-30): the closure baseline FR-6.1
      // compares against where the document root is untracked. It is a
      // derived record, rebuildable at any closed boundary, which is why it
      // sits under run/ rather than beside config.json.
      docBaselineFile: join(root, '.wardroom', 'run', 'doc-baseline.json'),
      // The owner's out-of-band context for the roles (§3.0, D-108), and the
      // cooperative stop request (§5.1, D-106). The request is a file rather
      // than a signal because `run` holds the terminal and `detach` is a
      // second process; its presence is the whole of the request, so it
      // carries no contents.
      inboxFile: join(root, '.wardroom', 'run', 'inbox.jsonl'),
      stopRequestFile: join(root, '.wardroom', 'run', 'stop-requested'),
      gatesDir: join(root, '.wardroom', 'run', 'gates'),
      auditLog: join(root, '.wardroom', 'run', 'gates', 'audit.jsonl'),
    });
  });

  it('keeps the inbox and the stop request among the runtime records', () => {
    // Both are runtime state and neither is the contract: a clone that carried
    // a stale stop request would stop at its first job boundary for a reason
    // nobody could see (D-106).
    const paths = wardroomPaths(root);

    expect(paths.inboxFile.startsWith(paths.runDir)).toBe(true);
    expect(paths.stopRequestFile.startsWith(paths.runDir)).toBe(true);
  });

  it('keeps the closure baseline among the runtime records', () => {
    const paths = wardroomPaths(root);

    expect(paths.docBaselineFile.startsWith(paths.runDir)).toBe(true);
  });

  it('keeps the configuration file outside the runtime directory', () => {
    const paths = wardroomPaths(root);

    expect(paths.configFile.startsWith(paths.runDir)).toBe(false);
  });
});

describe('ensureRunDir', () => {
  it('does not create the runtime directory merely by resolving paths', () => {
    wardroomPaths(root);

    expect(existsSync(join(root, '.wardroom', 'run'))).toBe(false);
  });

  it('creates the runtime directory on demand', () => {
    const runDir = ensureRunDir(root);

    expect(statSync(runDir).isDirectory()).toBe(true);
    expect(runDir).toBe(join(root, '.wardroom', 'run'));
  });

  it('is safe to call when the runtime directory already exists', () => {
    ensureRunDir(root);

    expect(() => ensureRunDir(root)).not.toThrow();
  });
});
