import type { TreeChange } from '../state/git.js';
import type { TourState } from '../state/marker.js';

/**
 * The gate queue entry (SDD §3.1): the durable record of a decision nobody has
 * made yet (SRS TD-3). It outlives the orchestrator process by design, so
 * everything a returning owner needs in order to answer is in the file.
 */

/**
 * The classes a gate can be raised for before a tour record exists (D-70).
 *
 * `dirty-tree` is raised at `IDLE`, where nothing has been planned; the
 * `tour-budget` gate is raised with no tour where a run of failed planning
 * attempts exhausted the budget, since planning is what creates the record
 * (D-45, D-50, D-59). Every other class is raised from inside a tour and
 * names it.
 */
export const PRE_RECORD_GATE_CLASSES = ['dirty-tree', 'tour-budget'] as const;

/** The TD-2 gate classes. */
export const GATE_CLASSES = [
  'push',
  'deployment',
  'scope-change',
  'destructive',
  'secrets',
  'tour-budget',
  'dirty-tree',
] as const;
export type GateClass = (typeof GATE_CLASSES)[number];

/**
 * Three values, and `expired` is not among them (BACKLOG D-27). The elapse of
 * `gate_wait` stamps `parked_at` on an otherwise untouched pending entry: a
 * gate is never resolved by the passage of time, only by the owner, and a
 * parked gate is answered exactly as a fresh one is (SDD §3.2).
 */
export const GATE_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type GateStatus = (typeof GATE_STATUSES)[number];

export interface PushPreview {
  readonly kind: 'push';
  readonly commits: readonly { readonly hash: string; readonly subject: string }[];
  readonly remote: string;
  readonly branch: string;
}

export interface DeploymentPreview {
  readonly kind: 'deployment';
  readonly environment: string;
  readonly changedServices: readonly string[];
  /** May be empty: a deployment with nothing pending is normal, and the empty list says so. */
  readonly pendingMigrations: readonly string[];
}

export interface ScopeChangePreview {
  readonly kind: 'scope-change';
  readonly sections: readonly {
    readonly document: string;
    readonly section: string;
    readonly diff: string;
  }[];
}

export interface DestructivePreview {
  readonly kind: 'destructive';
  readonly command: string;
  readonly affects: readonly string[];
}

/** Which secret, read or write, and for what purpose. Never the value (SDD §3.1). */
export interface SecretsPreview {
  readonly kind: 'secrets';
  readonly secret: string;
  readonly access: 'read' | 'write';
  readonly purpose: string;
}

export interface TourBudgetPreview {
  readonly kind: 'tour-budget';
  readonly attemptCount: number;
  readonly lastFailureOutput: string;
}

/**
 * The changed paths in the working tree, each with its change type (D-36).
 * Never empty: an empty list means the tree is clean and the gate should not
 * have been raised, so it is refused at enqueue (D-32).
 */
export interface DirtyTreePreview {
  readonly kind: 'dirty-tree';
  readonly changes: readonly TreeChange[];
}

/**
 * Class-specific evidence. The discriminant is the gate class, so a push
 * preview cannot be attached to a secrets gate: a preview the owner cannot
 * read against the action is the same as no preview, and a gate without its
 * preview must not be enqueued at all (SDD §3.1).
 */
export type GatePreview =
  | PushPreview
  | DeploymentPreview
  | ScopeChangePreview
  | DestructivePreview
  | SecretsPreview
  | TourBudgetPreview
  | DirtyTreePreview;

export interface GateEntry {
  readonly gateId: string;
  readonly gateClass: GateClass;
  readonly status: GateStatus;
  /**
   * The tour the gate was raised in, or null where no tour record existed
   * yet (SDD §3.1, D-70).
   *
   * Null, never an empty string. Null is a determinate fact about the action,
   * that nothing has been planned; an empty string is a field somebody failed
   * to fill, and collapsing the two reports the second as the first (D-32).
   */
  readonly tourId: string | null;
  readonly jobIndex: number | null;
  /** The state to return to once the gate is decided (SDD §3.2). */
  readonly interruptedState: TourState;
  /** One line, human language: the action being requested. */
  readonly what: string;
  /** The rule or condition that classified it as a gate. */
  readonly why: string;
  readonly preview: GatePreview;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decisionNote: string | null;
  /** Set when the waiting period elapsed (FR-3.3). Does not change `status`. */
  readonly parkedAt: string | null;
}

/** A resolved entry is one the owner has answered. Parking never resolves one. */
export function isResolved(entry: GateEntry): boolean {
  return entry.status !== 'pending';
}
