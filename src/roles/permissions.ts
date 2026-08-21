import { RUN_DIR_NAME, WARDROOM_DIR_NAME } from '../config/paths.js';
import type { ProjectConfig } from '../config/schema.js';
import { tourLogDirectory, versionCarryingDocuments } from '../documents/set.js';
import { gateClassesReachableBy } from '../gates/classify.js';
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
export const RUNTIME_DENY_RULE = fileRule(WARDROOM_DIR_NAME, RUN_DIR_NAME, '**');

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

/** A permission rule this module will not emit, with the reason it will not. */
export class PermissionRuleRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'PermissionRuleRefusedError';
    this.reason = reason;
  }
}

/** A rule naming a tool and nothing else, which auto-approves every call to it. */
function isBareToolName(rule: string): boolean {
  return !rule.includes('(');
}

/**
 * Refuses a bare tool name in an allow list where a gated action is reachable
 * through that tool (SDD §4.2).
 *
 * Exported so a test can feed it a list this module would never generate. It is
 * also run over what this module does generate, which is the half that keeps
 * the rule true after somebody edits {@link allowRules} in six months.
 */
export function checkAllowRules(role: RoleName, rules: readonly string[]): void {
  for (const rule of rules) {
    if (!isBareToolName(rule)) continue;
    const reachable = gateClassesReachableBy(rule);
    if (reachable.length === 0) continue;

    throw new PermissionRuleRefusedError(
      `the ${role} allow list names ${rule} bare, which auto-approves every call to it, ` +
        `and ${reachable.join(', ')} ${reachable.length === 1 ? 'is a gate class' : 'are gate classes'} ` +
        `reachable through it. Scope the rule, as in ${rule}(...) (SDD §4.2, D-43).`,
    );
  }
}

/**
 * The document root, denied one document at a time (D-44, SDD §4.2).
 *
 * Enumeration rather than a wildcard, because "the root except PROGRESS" is not
 * expressible: deny is evaluated before allow and wins, so PROGRESS cannot be
 * allowed back, and a path glob cannot express negation. The PROGRESS exception
 * is therefore not an exception in the configuration at all. PROGRESS is simply
 * not in the set this derives from.
 *
 * The set is {@link versionCarryingDocuments}, the same derivation the document
 * baseline uses (B-13), so the denial and the FR-6.1 version rule stay in step
 * by construction rather than by two lists being kept in agreement by hand.
 */
export function documentDenyRules(config: ProjectConfig): readonly string[] {
  return [
    ...versionCarryingDocuments(config.level).map((name) => fileRule(config.docRoot, name)),
    // The tour logs are canonical and carry no version (SRS §3.2, D-31), so
    // they are outside the version-carrying set and have to be named
    // separately. A directory rather than a file: they are written one per
    // closure and their names are not knowable in advance.
    fileRule(config.docRoot, tourLogDirectory(), '**'),
  ];
}

/** The permission rules for one role under one project contract. */
export function rolePermissions(role: RoleName, config: ProjectConfig): RolePermissions {
  const allow = allowRules(role, config);
  checkAllowRules(role, allow);

  return {
    allow,
    // The PM is the writer of the canonical documents (FR-2.1), so the
    // enumeration reaches the Implementer alone. Denying it to both would
    // leave the documents with no writer at all.
    deny: role === 'pm' ? [RUNTIME_DENY_RULE] : [RUNTIME_DENY_RULE, ...documentDenyRules(config)],
  };
}
