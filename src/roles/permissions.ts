import type { ProjectConfig } from '../config/schema.js';
import type { RoleName, RolePermissions } from './schema.js';

/**
 * The permission rules of each role, derived from the project contract
 * (SDD §4.2, Appendix A.2, BACKLOG D-44).
 *
 * Three facts from Appendix A.2 shape everything here.
 *
 * 1. `Edit(path)` rules govern every built-in that writes files, `Write` and
 *    `NotebookEdit` included. A rule written as `Write(path)` is never matched
 *    by the file permission checks: it denies nothing while reading as though
 *    it denied everything, which is worse than no rule at all.
 * 2. A single leading slash anchors a rule at its source, which for rules
 *    passed in options is the session's working directory. The anchor is
 *    written here rather than left to the default, because a rule whose reach
 *    depends on an unstated default is a rule nobody can check by reading it.
 * 3. Deny is evaluated before allow and wins, and a path glob cannot express
 *    negation. "The document root except PROGRESS" is therefore not a rule; it
 *    is an enumeration of the documents that ARE denied, with PROGRESS simply
 *    absent from the list.
 */

/** The `Edit(` prefix every file denial uses, stated once so a test can pin it. */
export const FILE_RULE_TOOL = 'Edit';

/**
 * Joins repository-relative segments and anchors the result at the session's
 * working directory.
 *
 * Every segment is trimmed of slashes on both edges before joining, because
 * `doc_root` is written by hand in `config.json` and `internal/docs/` is as
 * natural to write as `internal/docs`. A rule reading `Edit(/internal/docs//**)`
 * would be a rule that matches nothing while looking exactly like one that
 * matches everything, which is the same silent failure as writing `Write(`.
 */
export function anchoredPath(...segments: readonly string[]): string {
  const parts = segments
    .map((segment) => segment.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((segment) => segment !== '');
  return `/${parts.join('/')}`;
}

/** `Edit(/path)`: the only rule form the file permission checks match. */
export function fileRule(...segments: readonly string[]): string {
  return `${FILE_RULE_TOOL}(${anchoredPath(...segments)})`;
}

/**
 * The runtime records no role session writes: the state marker, the gate
 * entries and the audit log.
 *
 * The marker is written by the orchestrator and by nothing else (D-47): its
 * guarantee is one atomic write at a known instant, and a model session cannot
 * be relied on to perform exactly one write at exactly one moment. Gate entries
 * and the audit log are raised by the interception hook, which is orchestrator
 * code (SDD §3.1, §4.2). A session that could edit any of the three could
 * approve its own gate by editing the file that records it.
 */
export const RUNTIME_DENY_RULE = fileRule('.wardroom/run', '**');

/**
 * The calls a role may make without being asked about them.
 *
 * Auto-approval is kept narrow on purpose. What is not on this list is not
 * forbidden: it falls through to `canUseTool`, which SDD §4.2 keeps configured
 * as the second line for the modes that prompt. A wide allow list buys nothing
 * except the loss of that second look.
 */
function allowRules(role: RoleName, config: ProjectConfig): readonly string[] {
  if (role === 'pm') {
    // The PM's own job, and the only writes FR-2.1 gives it.
    return [`Read(${anchoredPath(config.docRoot, '**')})`, fileRule(config.docRoot, '**')];
  }

  // The green definition and nothing else (SRS §3.4, BACKLOG D-13). Each
  // command is written out in full rather than as a prefix pattern: `npm run
  // test` is a command the contract names, `npm run *` is a family the
  // contract does not, and `git push` is one `Bash` away from the second.
  return config.verify.map((command) => `Bash(${command})`);
}

/** The permission rules for one role under one project contract. */
export function rolePermissions(role: RoleName, config: ProjectConfig): RolePermissions {
  return {
    allow: allowRules(role, config),
    deny: [RUNTIME_DENY_RULE],
  };
}
