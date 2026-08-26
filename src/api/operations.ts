import { gateDecide, gateList, gateShow } from './gates.js';
import { historyLog } from './history.js';
import { configShow, decisionInject, projectDetach, projectRun } from './project.js';
import { projectStatus } from './status.js';
import { usageReport } from './usage.js';

/**
 * The internal API (SDD §5.1, FR-5.1).
 *
 * One surface-agnostic operation set. Every surface, the v1 CLI and the
 * graphical and messaging surfaces that follow, is a thin client over it,
 * holding no state and no logic of its own. A surface with a privileged
 * operation the others cannot reach is the violation FR-5.1 names, and the
 * only defence against it is that this is the whole list and every surface
 * binds to it mechanically.
 *
 * Every operation takes the project path first. Not a working directory, not
 * an ambient default, not a remembered last project: a command that acts on a
 * project the owner did not name and cannot see is the shape every destructive
 * accident in a multi-project setup takes (§5.2, D-109). Resolving a path from
 * a working directory is the surface's job, and it happens before any of these
 * are called.
 *
 * None of them writes to a terminal. That is not a style rule: an operation
 * that printed would work on one surface and be invisible or corrupting on
 * every other, which is FR-5.1 broken from the inside.
 *
 * **`project.kickoff` is absent, deliberately.** §5.1's table names it and
 * §4.7 records that kickoff has no procedure section yet. There is nothing to
 * implement it from, and an operation that refused every call would look like
 * coverage while providing none. The gap is reported rather than papered over.
 */

/**
 * The operation names §5.1's table gives, as data.
 *
 * Written out here so that the set has one home a test can read: a table in a
 * document and a set of exported functions drift apart silently, and the drift
 * is invisible from either side. `project.kickoff` is in the list and not in
 * the object below, which is what makes the gap visible rather than merely
 * true.
 */
export const OPERATION_NAMES = [
  'project.kickoff',
  'project.run',
  'project.detach',
  'project.status',
  'gate.list',
  'gate.show',
  'gate.decide',
  'decision.inject',
  'usage.report',
  'history.log',
  'config.show',
] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

/** The operations that exist, keyed by the name §5.1 gives them. */
export const operations = {
  'project.run': projectRun,
  'project.detach': projectDetach,
  'project.status': projectStatus,
  'gate.list': gateList,
  'gate.show': gateShow,
  'gate.decide': gateDecide,
  'decision.inject': decisionInject,
  'usage.report': usageReport,
  'history.log': historyLog,
  'config.show': configShow,
} as const;

/**
 * The operations §5.1 names and this module does not carry.
 *
 * One entry, with its reason, rather than a silence. A surface reading this
 * can say why a command is missing instead of behaving as though the operation
 * were never specified.
 */
export const UNIMPLEMENTED_OPERATIONS: Readonly<Record<string, string>> = {
  'project.kickoff':
    'kickoff has no procedure section in the design yet (SDD §4.7), so there is nothing to implement it from. FR-4.1 to FR-4.4 state what it must do and no section states how, and the missing half is a document pass rather than a coding one.',
};
