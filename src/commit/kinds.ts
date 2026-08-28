/**
 * The two constants the gate and its derivation both need (SDD §4.5).
 *
 * Their own module because the alternative is a runtime import cycle, and this
 * project has now met what that cycle does. `occasion.ts` needs the WIP prefix
 * to recognise a stop, and since D-115 `gate.ts` needs `occasion.ts` to derive
 * what a caller did not name. With both constants living in `gate.ts`, the
 * prefix was read while its own module was still evaluating, so a message that
 * quotes it rendered as `beginning undefined`: the refusal still refused, and
 * only the sentence explaining it to the owner was nonsense, which is the kind
 * of defect that ships.
 *
 * They are re-exported from `gate.ts`, which is where a reader looks for them,
 * so this file is a fact about module loading and not a second home.
 */

/**
 * The three occasions FR-7.1 allows. The whole list: there is no periodic
 * autosave commit, no per file commit, and no squash step later, because
 * squashing would rewrite history, which is the owner's operation and never
 * Wardroom's (SDD §4.5).
 */
export const COMMIT_OCCASIONS = ['job-boundary', 'closure', 'wip-stop'] as const;
export type CommitOccasionKind = (typeof COMMIT_OCCASIONS)[number];

/** How a WIP stop announces itself in the log, so a second one can be seen. */
export const WIP_SUBJECT_PREFIX = 'WIP:';
