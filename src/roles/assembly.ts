import type { CanUseTool, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ProjectConfig } from '../config/schema.js';
import type { RoleName } from './schema.js';
import { RoleSessionRefusedError, buildRoleSession } from './session.js';

/**
 * The assembled session (SDD §4.2, D-43, D-53, D-56, D-85).
 *
 * The factory in `session.ts` builds a role's options from the project
 * contract. This module is what turns those options into something a driver
 * can run, and it is where the three attachments stop being optional.
 *
 * They are optional there and required here on purpose. Options are inspected
 * by tests and by `config.show`, where a partial set is a legitimate thing to
 * look at; a session that is about to run is not. Each attachment is one line
 * of the mechanism that holds a push, and a session missing one still answers
 * every question a session answers, so nothing downstream would notice:
 *
 * - the **role factory** supplies the system prompt, tool surface and
 *   permission rules that separate the two roles (FR-2.1);
 * - the **`PreToolUse` hook** is the interception the gate queue rests on,
 *   because it runs before every other permission step and its denial holds
 *   even where a rule would have approved the call (Appendix A.2, D-43);
 * - the **`canUseTool` supplier** is the second line for the modes that
 *   prompt, and is not sufficient alone, which is why both are required rather
 *   than either.
 *
 * The SDK call sits behind `query`, the one seam (D-85). The seam is a
 * parameter rather than a module-level default so that no code path can reach
 * the real SDK by forgetting to override one: a session with no seam is
 * refused, exactly as one with no hook is.
 */

export { RoleSessionRefusedError } from './session.js';

/** The shape of the SDK's `query`, which is the only thing this module calls. */
export type QueryFn = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}) => Query;

/**
 * The three attachments, as data.
 *
 * The refusals below are generated from this list rather than written out one
 * by one, so a fourth attachment cannot be added to the input without its
 * check appearing at the same time. A required field whose check was forgotten
 * is the same defect as a field that was never required.
 */
export const requiredAttachments = ['hooks', 'canUseTool', 'query'] as const;
export type RequiredAttachment = (typeof requiredAttachments)[number];

const WHY_REQUIRED: Record<RequiredAttachment, string> = {
  hooks:
    'the PreToolUse hook is the interception the gate queue rests on, and it runs before every other permission step (SDD Appendix A.2, D-43)',
  canUseTool: 'the canUseTool supplier is the second line for the modes that prompt (SDD §4.2)',
  query:
    'the SDK call sits behind one seam, and a session with no seam would reach the live API instead (D-85)',
};

export interface AssembleSessionInput {
  readonly role: RoleName;
  readonly config: ProjectConfig;
  /** The repository Wardroom manages; the session's working directory. */
  readonly root: string;
  readonly hooks?: Options['hooks'];
  readonly canUseTool?: CanUseTool;
  readonly query?: QueryFn;
  /** Refused rather than silently corrected, as at the factory. */
  readonly permissionMode?: Options['permissionMode'];
}

export interface AssembledSession {
  readonly role: RoleName;
  readonly options: Options;
  /** Opens the session through the seam. Nothing runs until this is called. */
  readonly open: (prompt: string | AsyncIterable<SDKUserMessage>) => Query;
}

/**
 * Whether a hook set actually intercepts.
 *
 * Presence is not the check. An empty hook set and a `PreToolUse` entry with
 * no hook in it both pass a presence check and intercept nothing, which is the
 * shape where every call reaches its tool with no gate raised anywhere: the
 * mechanism reports itself installed and does nothing, which is worse than
 * being absent because absence is what the refusal below can see.
 */
function intercepts(hooks: Options['hooks']): boolean {
  const entries = hooks?.PreToolUse;
  if (entries === undefined || entries.length === 0) return false;
  return entries.some((entry) => entry.hooks.length > 0);
}

export function assembleSession(input: AssembleSessionInput): AssembledSession {
  for (const attachment of requiredAttachments) {
    if (input[attachment] === undefined) {
      throw new RoleSessionRefusedError(
        `a ${input.role} session cannot run without ${attachment}: ${WHY_REQUIRED[attachment]}.`,
      );
    }
  }
  if (!intercepts(input.hooks)) {
    throw new RoleSessionRefusedError(
      `a ${input.role} session cannot run with a hooks set that carries no PreToolUse hook: ${WHY_REQUIRED.hooks}. An installed hook that intercepts nothing is the failure this refusal exists to catch.`,
    );
  }

  // The factory owns the mode check and every option that is not an
  // attachment, so a rule cannot hold here and not there.
  const built = buildRoleSession({
    role: input.role,
    config: input.config,
    root: input.root,
    ...(input.hooks === undefined ? {} : { hooks: input.hooks }),
    ...(input.canUseTool === undefined ? {} : { canUseTool: input.canUseTool }),
    ...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
  });

  // Narrowed rather than cast. The loop above has already refused an absent
  // seam, so this cannot fire; a cast here would keep compiling if that loop
  // were ever changed, and would hand back a session whose `open` is not a
  // function. The redundant guard is the cheaper of the two mistakes.
  const { query } = input;
  if (query === undefined) throw new RoleSessionRefusedError(WHY_REQUIRED.query);

  return {
    role: built.role,
    options: built.options,
    open: (prompt) => query({ prompt, options: built.options }),
  };
}
