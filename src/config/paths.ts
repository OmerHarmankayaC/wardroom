import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `.wardroom/` layout (SDD §3.0). Two categories with different lifetimes
 * and different tracking rules: `config.json` is the project contract and is
 * always tracked; everything under `run/` is a runtime record and may be
 * excluded (BACKLOG D-15). The directory shape encodes that split so no file
 * is ever ambiguous. See ./tracking.ts.
 */
export interface WardroomPaths {
  /** The project root: the git repository Wardroom manages. */
  readonly root: string;
  readonly wardroomDir: string;
  /** The project contract. Always tracked. */
  readonly configFile: string;
  /** Runtime records. Tracked unless `track_runtime` is false. */
  readonly runDir: string;
  readonly stateFile: string;
  /** Per canonical document, its version and content hash at the last tour close. */
  readonly docBaselineFile: string;
  readonly gatesDir: string;
  readonly auditLog: string;
}

/** Resolves the layout for a project root. Touches no filesystem. */
export function wardroomPaths(root: string): WardroomPaths {
  const wardroomDir = join(root, '.wardroom');
  const runDir = join(wardroomDir, 'run');
  const gatesDir = join(runDir, 'gates');
  return {
    root,
    wardroomDir,
    configFile: join(wardroomDir, 'config.json'),
    runDir,
    stateFile: join(runDir, 'state.json'),
    docBaselineFile: join(runDir, 'doc-baseline.json'),
    gatesDir,
    auditLog: join(gatesDir, 'audit.jsonl'),
  };
}

/**
 * Creates the runtime directory if it is not there yet and returns it.
 * Runtime records are created on demand: a repository that has never been run
 * carries no `run/` directory, and its absence is what tells resume that the
 * repository has never been run at all (SDD §4.4 step 1).
 */
export function ensureRunDir(root: string): string {
  const { runDir } = wardroomPaths(root);
  mkdirSync(runDir, { recursive: true });
  return runDir;
}
