import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The `.wardroom/` layout (SDD §3.0). Two categories with different lifetimes
 * and different tracking rules: `config.json` is the project contract and is
 * always tracked; everything under `run/` is a runtime record and may be
 * excluded (BACKLOG D-15). The directory shape encodes that split so no file
 * is ever ambiguous. See ./tracking.ts.
 */
/**
 * The two directory names the layout is built from, named rather than written
 * out at each use. The permission rules deny the runtime directory by path
 * (../roles/permissions.ts), and a rule holding its own copy of the layout is a
 * rule that stops denying anything the day the layout moves.
 */
export const WARDROOM_DIR_NAME = '.wardroom';
export const RUN_DIR_NAME = 'run';

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
  /** The failure the current attempt count was spent on (SDD §3.0, D-48, D-59). */
  readonly lastFailureFile: string;
  /** The token and cost record, append-only (SDD §3.0, NFR-4, D-74). */
  readonly usageLog: string;
  /** One closing report per tour, which closure reads (SDD §3.0, §4.6, D-73). */
  readonly reportsDir: string;
  /** The owner's out-of-band context for the roles (SDD §3.0, §5.1, D-108). */
  readonly inboxFile: string;
  /**
   * The cooperative stop request (SDD §5.1, D-106).
   *
   * A file rather than a signal or a socket: `run` holds the terminal, so
   * `detach` is a second process and cannot call into the first, and durable
   * state lives in repository files (TD-3). Its presence is the request and
   * its absence is the whole of the answer, so it carries no contents.
   */
  readonly stopRequestFile: string;
  readonly gatesDir: string;
  readonly auditLog: string;
}

/** Resolves the layout for a project root. Touches no filesystem. */
export function wardroomPaths(root: string): WardroomPaths {
  const wardroomDir = join(root, WARDROOM_DIR_NAME);
  const runDir = join(wardroomDir, RUN_DIR_NAME);
  const gatesDir = join(runDir, 'gates');
  return {
    root,
    wardroomDir,
    configFile: join(wardroomDir, 'config.json'),
    runDir,
    stateFile: join(runDir, 'state.json'),
    docBaselineFile: join(runDir, 'doc-baseline.json'),
    lastFailureFile: join(runDir, 'last-failure.json'),
    usageLog: join(runDir, 'usage.jsonl'),
    reportsDir: join(runDir, 'reports'),
    inboxFile: join(runDir, 'inbox.jsonl'),
    stopRequestFile: join(runDir, 'stop-requested'),
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
