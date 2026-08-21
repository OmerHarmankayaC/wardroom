import type { GateClass } from './schema.js';

/**
 * Which tools can reach which TD-2 gate classes.
 *
 * SDD §4.2: "No bare tool name therefore appears in a role's allow list where a
 * gated action is reachable through that tool." That rule needs a stated answer
 * to "reachable through which tool", and this table is it, in one place so the
 * allow-list check and the call classifier cannot disagree about what a gated
 * action is.
 *
 * The interception hook runs before the allow rules (Appendix A.2), so a bare
 * name no longer walks a call past the gate the way it would have under the
 * `canUseTool` design D-43 replaced. The rule is kept anyway: it costs a scoped
 * rule instead of a bare one, and it is the difference between a gate with one
 * mechanism holding it up and a gate with two.
 *
 * The table covers the built-in tools. A role session configures no MCP
 * servers, so there are no `mcp__` tools in its surface to reach a class
 * through; the day one is added, it is added here in the same change.
 *
 * Three of the seven classes are absent by construction. `scope-change`,
 * `tour-budget` and `dirty-tree` are raised by the orchestrator from its own
 * state, never by a tool call, so no tool reaches them and no allow rule can
 * shadow them.
 */
export const GATE_REACHING_TOOLS: Readonly<Record<string, readonly GateClass[]>> = {
  // The shell reaches almost everything: `git push`, a deploy command, `rm -rf`
  // and `cat .env` are all one Bash call.
  Bash: ['push', 'deployment', 'destructive', 'secrets'],
  // Anything that can read a file's contents can read the file the secrets are
  // in. A path listing cannot, which is why Glob is not here.
  Read: ['secrets'],
  Grep: ['secrets'],
  // Every built-in that writes files. `Edit(path)` rules govern all three
  // (A.2), and all three can write a secret as easily as read one.
  Edit: ['secrets'],
  Write: ['secrets'],
  NotebookEdit: ['secrets'],
};

/** The classes reachable through one tool; empty for a tool that reaches none. */
export function gateClassesReachableBy(tool: string): readonly GateClass[] {
  return GATE_REACHING_TOOLS[tool] ?? [];
}

/**
 * What a classified call is, in the terms the gate entry needs: the TD-2 class,
 * the one line the owner reads, the rule that classified it, and the facts the
 * preview will be built from.
 *
 * The classifier does not build the preview. A push preview needs the commit
 * list, which needs the repository; a deployment preview needs the pending
 * migrations, which needs the project. Both belong to the orchestrator that has
 * them, so what crosses this boundary is what the call itself said.
 */
export type ClassifiedDetail =
  | { readonly kind: 'push'; readonly remote: string | null; readonly branch: string | null }
  | { readonly kind: 'destructive'; readonly command: string }
  | { readonly kind: 'secrets'; readonly secret: string; readonly access: 'read' | 'write' };

export interface ToolCallClassification {
  readonly gateClass: GateClass;
  /** One line, human language: the action being requested (SDD §3.1). */
  readonly what: string;
  /** The rule or condition that classified it as a gate. */
  readonly why: string;
  readonly detail: ClassifiedDetail;
}

/**
 * `deployment` has no detector here, and its absence is deliberate rather than
 * forgotten. A deploy command is whatever the project says it is, and the
 * project contract (SRS §3.1) has no field that says so: `verify` names the
 * green definition and nothing names the deployment. Guessing at `deploy` in a
 * command line would catch a script called `deploy-docs` and miss one called
 * `ship`, which is a check that reports confidence it does not have. This is
 * reported as a document debt rather than answered here.
 */

/**
 * Wrappers that stand in front of the command without changing what it is.
 * Stripped so `sudo rm -rf` is read as `rm -rf`.
 *
 * This list is a floor, not a fence. A command line can always hide its intent,
 * behind a shell script, an alias, or a here-doc, and no scanner reading command
 * text will catch all of them. That is why the classifier is one of three lines
 * and not the only one: the deny rules hold in every mode and the tool surface
 * decides what exists to call at all (SDD Appendix A.2, §4.2).
 */
const COMMAND_WRAPPERS = /^(sudo|nohup|time|command|exec)\s+/;

/** Segments of a compound command line, so `cd x && git push` is not missed. */
function commandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((segment) => segment.trim().replace(COMMAND_WRAPPERS, '').trim())
    .filter((segment) => segment !== '');
}

const PUSH_COMMAND = /^git\s+push\b/;
/** The remote operations TD-2 names beside push: the ones that change a remote. */
const REMOTE_MUTATION = /^git\s+remote\s+(add|remove|rm|set-url|rename|prune)\b/;

/** `git push [flags] <remote> [branch]`, with flags skipped. */
function pushTarget(segment: string): { remote: string | null; branch: string | null } {
  const words = segment.split(/\s+/).slice(2);
  const positional = words.filter((word) => !word.startsWith('-'));
  return { remote: positional[0] ?? null, branch: positional[1] ?? null };
}

/**
 * Commands that lose work rather than change it. `git stash` is here because
 * a stash gets popped over and garbage-collected (SDD §4.2), which is losing
 * work by a slower route than `rm`.
 */
const DESTRUCTIVE_COMMANDS: readonly RegExp[] = [
  /^rm\s+(-\S*[rR]\S*\s+)/,
  /^git\s+clean\b/,
  /^git\s+reset\s+--hard\b/,
  /^git\s+stash\b/,
];

/**
 * A file holding secret values. `.env.example` is excluded by name: it is the
 * shape file and carries no value, so gating it would spend an owner's
 * attention on a file that is committed anyway.
 */
const SECRETS_FILE = /(^|[/\\])\.env(\.[A-Za-z0-9_-]+)?$/;
const SECRETS_SHAPE_FILE = /(^|[/\\])\.env\.example$/;

function isSecretsPath(path: string): boolean {
  return SECRETS_FILE.test(path) && !SECRETS_SHAPE_FILE.test(path);
}

/** The first secrets path named anywhere in a command line, or null. */
function secretsPathIn(command: string): string | null {
  for (const word of command.split(/\s+/)) {
    const bare = word.replace(/^["']|["']$/g, '');
    if (isSecretsPath(bare)) return bare;
  }
  return null;
}

const WRITING_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];

function classifyBash(command: string): ToolCallClassification | null {
  for (const segment of commandSegments(command)) {
    const isPush = PUSH_COMMAND.test(segment);
    if (!isPush && !REMOTE_MUTATION.test(segment)) continue;
    return {
      gateClass: 'push',
      what: `Run \`${command}\``,
      why: 'TD-2 classifies git push and remote operations as critical actions',
      // A remote being added names no branch, so the two arms of the same
      // class answer with what they have rather than with a guess.
      detail: isPush
        ? { kind: 'push', ...pushTarget(segment) }
        : { kind: 'push', remote: null, branch: null },
    };
  }

  for (const segment of commandSegments(command)) {
    if (DESTRUCTIVE_COMMANDS.some((pattern) => pattern.test(segment))) {
      return {
        gateClass: 'destructive',
        what: `Run \`${command}\``,
        why: 'TD-2 classifies destructive operations as critical actions',
        detail: { kind: 'destructive', command },
      };
    }
  }

  const secret = secretsPathIn(command);
  if (secret !== null) {
    // Read or write is judged from a redirection, which is the only thing a
    // command line says about direction without interpreting the program. A
    // command that writes by another route is reported as a read against the
    // right file, which is the safe way round: the owner still sees the exact
    // command in `what`.
    return {
      gateClass: 'secrets',
      what: `Run \`${command}\``,
      why: 'TD-2 classifies secrets access as a critical action',
      detail: { kind: 'secrets', secret, access: command.includes('>') ? 'write' : 'read' },
    };
  }

  return null;
}

function classifyFileTool(toolName: string, path: string): ToolCallClassification | null {
  if (!isSecretsPath(path)) return null;
  const access = WRITING_TOOLS.includes(toolName) ? 'write' : 'read';
  return {
    gateClass: 'secrets',
    what: `${access === 'write' ? 'Write' : 'Read'} ${path}`,
    why: 'TD-2 classifies secrets access as a critical action',
    detail: { kind: 'secrets', secret: path, access },
  };
}

function stringField(input: unknown, field: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : null;
}

/**
 * The TD-2 class of a tool call, or null where the call is ordinary.
 *
 * Null rather than a throw for an input this cannot read: an unreadable tool
 * input is not evidence of a gated action, and refusing the call would turn a
 * parser gap into an outage. What it must never do is answer null because it
 * decided not to look, which is why the tool surface it looks at is the same
 * table {@link GATE_REACHING_TOOLS} the allow-list check reads.
 */
export function classifyToolCall(
  toolName: string,
  toolInput: unknown,
): ToolCallClassification | null {
  if (gateClassesReachableBy(toolName).length === 0) return null;

  if (toolName === 'Bash') {
    const command = stringField(toolInput, 'command');
    return command === null ? null : classifyBash(command);
  }

  const path = stringField(toolInput, 'file_path') ?? stringField(toolInput, 'notebook_path');
  return path === null ? null : classifyFileTool(toolName, path);
}
