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
