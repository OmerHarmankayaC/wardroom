import type { CanUseTool, Options, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { ProjectConfig } from '../config/schema.js';
import { roleDefinition } from './definition.js';
import { rolePermissions } from './permissions.js';
import type { RoleName } from './schema.js';

/**
 * The role session factory (SDD §4.1, §4.2, BACKLOG D-43).
 *
 * One builder, two roles. Everything that is not a role difference is set here
 * once, so a capability cannot arrive in one role without arriving in the
 * other: the roles differ in system prompt, tool surface and permission rules,
 * and a difference anywhere else is a defect this module exists to make
 * impossible rather than to detect.
 */

/**
 * Both roles run in `default` (SDD §4.2). Stated as a constant because two
 * places need it, the builder and the test that pins it, and a mode is exactly
 * the kind of fact that drifts when it is written twice.
 */
export const ROLE_PERMISSION_MODE: PermissionMode = 'default';

/**
 * The three modes D-43 bans outright, each for its own reason:
 * `bypassPermissions` approves what reaches it and is not constrained by
 * `allowedTools` at all, `dontAsk` denies without consulting the callback, and
 * `auto` hands a permission prompt to a model classifier. A gate resolved by
 * anything other than the owner is not a gate (FR-3.1).
 */
export const BANNED_PERMISSION_MODES = ['bypassPermissions', 'dontAsk', 'auto'] as const;

const BAN_REASONS: Record<(typeof BANNED_PERMISSION_MODES)[number], string> = {
  bypassPermissions:
    'it approves whatever reaches it and is not constrained by the allow list at all',
  dontAsk: 'it denies without consulting the callback',
  auto: 'it resolves permission prompts with a model classifier, which is not the owner',
};

/** A session this factory will not build, with the reason it will not. */
export class RoleSessionRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'RoleSessionRefusedError';
    this.reason = reason;
  }
}

export interface BuildRoleSessionInput {
  readonly role: RoleName;
  readonly config: ProjectConfig;
  /** The repository Wardroom manages; the session's working directory. */
  readonly root: string;
  /**
   * Gate interception (SDD §4.2, D-43). Passed in rather than built here: the
   * hook needs the gate queue and a way to block, which belong to the
   * orchestrator, and the same object is installed on both roles so neither can
   * end up intercepted less than the other.
   */
  readonly hooks?: Options['hooks'];
  /**
   * The second line for the modes that prompt (SDD §4.2). Nothing depends on it
   * alone: a call auto-approved at an earlier step never reaches it, which is
   * why the gate is a hook and not this (Appendix A.2).
   */
  readonly canUseTool?: CanUseTool;
  /**
   * Present so that a caller asking for a mode is refused rather than silently
   * corrected. A configuration that quietly rewrites what it was asked for
   * teaches its caller that the request was honoured.
   */
  readonly permissionMode?: PermissionMode;
}

export interface RoleSession {
  readonly role: RoleName;
  readonly options: Options;
}

function checkMode(mode: PermissionMode): void {
  const banned = BANNED_PERMISSION_MODES.find((name) => name === mode);
  if (banned !== undefined) {
    throw new RoleSessionRefusedError(
      `a role session cannot run in ${banned}: ${BAN_REASONS[banned]} (D-43, SDD Appendix A.2).`,
    );
  }
  if (mode !== ROLE_PERMISSION_MODE) {
    throw new RoleSessionRefusedError(
      `a role session cannot run in ${mode}: both roles run in ${ROLE_PERMISSION_MODE} (SDD §4.2).`,
    );
  }
}

/**
 * Builds one role's session options from the project contract.
 *
 * No filesystem settings are loaded. Omitting `settingSources` loads the user,
 * project and local settings files, any of which could carry a default
 * permission mode or an allow rule that undoes what is configured here, and
 * FR-2.1 forbids resting the role boundary on a mechanism a permission setting
 * can skip. The contract is the whole input; a file outside it is not.
 */
export function buildRoleSession(input: BuildRoleSessionInput): RoleSession {
  const mode = input.permissionMode ?? ROLE_PERMISSION_MODE;
  checkMode(mode);

  const definition = roleDefinition(input.role);
  const permissions = rolePermissions(input.role, input.config);

  return {
    role: input.role,
    options: {
      cwd: input.root,
      systemPrompt: definition.systemPrompt,
      tools: [...definition.tools],
      allowedTools: [...permissions.allow],
      disallowedTools: [...permissions.deny],
      permissionMode: mode,
      settingSources: [],
      // Spread rather than assigned, so an absent hook set or callback leaves
      // the key absent instead of present and undefined. The two are the same
      // to the SDK and are not the same to the test that compares the roles
      // option by option.
      ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
      ...(input.canUseTool === undefined ? {} : { canUseTool: input.canUseTool }),
    },
  };
}
