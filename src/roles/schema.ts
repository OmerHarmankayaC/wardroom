/**
 * The two agent roles (CHARTER §1, SRS §1.2, SDD §4.1 to §4.2).
 *
 * A role is not a process and not a prompt: it is one named configuration of
 * the same SDK session builder (SDD §2, BACKLOG D-4). What makes a role a role
 * is written here and read by ./session.ts, ./definition.ts and
 * ./permissions.ts, so no consumer decides for itself what a PM is.
 */

export const ROLES = ['pm', 'implementer'] as const;
export type RoleName = (typeof ROLES)[number];

/**
 * A role's permission rules, in the two lists the SDK evaluates separately.
 *
 * `deny` is the absolute prohibition: it is evaluated before everything except
 * the hooks and holds in every permission mode, so it is where a rule that must
 * not be switched off belongs (SDD Appendix A.2).
 *
 * `allow` is auto-approval, not capability. Widening it never grants a role a
 * tool it does not have in its surface, and narrowing it never takes one away:
 * it decides only which calls proceed without being asked about.
 */
export interface RolePermissions {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * What distinguishes one role from another, and nothing else. Every other
 * option a session carries is a property of the project or of the orchestrator,
 * shared by both roles by construction (SDD §4.2).
 */
export interface RoleDefinition {
  readonly role: RoleName;
  readonly systemPrompt: string;
  /** The base set of built-in tools available to the role. */
  readonly tools: readonly string[];
}
