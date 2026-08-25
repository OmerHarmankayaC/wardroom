import { isAbsolute, relative, resolve } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { classifyToolCall, pathsInCommand } from '../gates/classify.js';

/**
 * The `canUseTool` supplier (SDD §4.2, BACKLOG D-56).
 *
 * The allow list is deliberately narrow: for the Implementer it is the green
 * definition's commands and nothing else, and both roles run in `default`.
 * Everything ordinary a session does, writing a source file, running the
 * package manager, creating a commit, therefore reaches the permission prompt,
 * which the SDK routes here. A session with no supplier configured cannot act
 * at all, so this is not a redundancy behind the hook: it is the path almost
 * every call takes.
 *
 * It is orchestrator code and never a model. `auto` mode is banned for putting
 * a classifier in front of the owner's decisions, and putting one in front of
 * the ordinary decisions instead would be the same mistake one step down. What
 * is here is a comparison of paths and a table lookup, and nothing else.
 */

/**
 * Where a tool call's effects land, as far as a tool input can say.
 *
 * This is a floor rather than a fence, and the limit is worth stating plainly:
 * a shell command's effects are not decidable from its text. A script can
 * write anywhere, an alias can be anything, and `$HOME` is expanded by a shell
 * this code never runs. What the scan catches is the ordinary case, an
 * argument or a `cd` naming somewhere else, and the lines that do not depend
 * on reading a command correctly are the deny rules, which hold in every mode,
 * and the tool surface, which decides what exists to call (Appendix A.2).
 */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const;

function pathsIn(toolName: string, input: Record<string, unknown>): string[] {
  if (toolName === 'Bash') {
    const command = input.command;
    return typeof command === 'string' ? pathsInCommand(command) : [];
  }
  return PATH_FIELDS.map((field) => input[field]).filter(
    (value): value is string => typeof value === 'string',
  );
}

/**
 * Whether a path resolves inside the repository.
 *
 * Compared by resolved path segments rather than by string prefix: a sibling
 * directory named `wardroom-other` starts with `wardroom` and is not inside it,
 * and a prefix test would approve every one of them.
 */
function isInside(root: string, candidate: string): boolean {
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate);
  const step = relative(resolve(root), resolve(absolute));
  return step === '' || (!step.startsWith('..') && !isAbsolute(step));
}

export interface PermissionSupplierInput {
  /** The repository Wardroom manages; the boundary this supplier enforces. */
  readonly root: string;
}

const allow: PermissionResult = { behavior: 'allow' };

function deny(message: string): PermissionResult {
  return { behavior: 'deny', message };
}

/**
 * Builds the supplier for one repository.
 *
 * Returns a promise because the SDK's contract is asynchronous, not because
 * anything here waits on something. Nothing here is awaited and nothing here
 * can be: an answer that depended on a round trip would be an answer a network
 * failure could change.
 */
export function createPermissionSupplier(input: PermissionSupplierInput): CanUseTool {
  const root = resolve(input.root);

  return (toolName, toolInput) => {
    // A gate class arriving here is a defect in the classifier or in the hook
    // that reads it, because the hook runs before the permission mode and
    // catches these first (Appendix A.2). Approving it would resolve a gate by
    // a second mechanism that was never meant to judge it, and denying it
    // silently would hide the defect, so it is denied and named.
    const classification = classifyToolCall(toolName, toolInput);
    if (classification !== null) {
      return Promise.resolve(
        deny(
          `This is a ${classification.gateClass} gate and it reached the permission supplier, which never approves one. The PreToolUse hook runs before the permission mode and should have caught it, so this is a defect in the classifier or in the hook, not a decision to make here (SDD §4.2, D-56).`,
        ),
      );
    }

    for (const candidate of pathsIn(toolName, toolInput)) {
      if (!isInside(root, candidate)) {
        return Promise.resolve(
          deny(
            `${toolName} reaches ${candidate}, which is outside the repository Wardroom manages (${root}). A session acts on the project it was given and nowhere else (SDD §4.2, D-56).`,
          ),
        );
      }
    }

    return Promise.resolve(allow);
  };
}
