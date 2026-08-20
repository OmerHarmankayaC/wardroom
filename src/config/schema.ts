/**
 * The project contract (SRS §3.1): what Wardroom must know about a repository
 * before it can manage it. Small, durable and secret-free: `auth_mode` names
 * an authentication path, never a key (SDD §3.0).
 */

/** Selects the canonical document set (SRS §3.2). */
export const PROJECT_LEVELS = ['light', 'standard', 'full'] as const;
export type ProjectLevel = (typeof PROJECT_LEVELS)[number];

/** The two supported authentication paths (SDD Appendix A.3). */
export const AUTH_MODES = ['api_key', 'subscription'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** Language, runtime and package manager, as stated at kickoff. */
export interface ProjectStack {
  readonly language: string;
  readonly runtime: string;
  readonly packageManager: string;
}

/** The metered ceiling that ends a tour at a job boundary (FR-1.4, NFR-4). */
export interface UsageBudget {
  readonly usd: number;
}

export interface ProjectConfig {
  readonly name: string;
  readonly level: ProjectLevel;
  /** Where the canonical documents live; `docs/` unless the project says otherwise. */
  readonly docRoot: string;
  readonly stack: ProjectStack;
  /**
   * The green definition (SRS §3.4): an ordered list of commands, every one of
   * which must exit zero. This is its single home; documents and CLAUDE.md
   * cite it and never restate it (BACKLOG D-13).
   */
  readonly verify: readonly string[];
  readonly authMode: AuthMode;
  /** How long a pending gate waits before it parks the tour (FR-3.3). */
  readonly gateWait: string;
  /** Failed verification attempts before a tour-budget gate (FR-1.3). */
  readonly attemptBudget: number;
  readonly usageBudget: UsageBudget;
  /** Whether runtime records are committed (SRS §3.7). Never applies to this file. */
  readonly trackRuntime: boolean;
}
