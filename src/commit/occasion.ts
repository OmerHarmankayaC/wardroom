import type { StateMarker } from '../state/marker.js';
import {
  type ClosureOccasion,
  type CommitOccasion,
  type JobBoundaryOccasion,
  WIP_SUBJECT_PREFIX,
  type WipStopOccasion,
} from './gate.js';

/**
 * Where the commit gate's occasion comes from (SDD §4.5, D-105).
 *
 * It used to come from the caller: an optional value fixed when the session
 * was built. No caller filled it, so every commit a live session made was
 * denied for want of an occasion nobody supplied, and a value fixed at
 * construction could not have been right anyway, since one Implementer session
 * spans many boundaries (D-99).
 *
 * So it is derived at the moment of the call instead, from the record that
 * already knows where the orchestrator is. The hook reads the marker on that
 * path already (§4.2), and the marker carries the state, the tour, the job
 * index and the disposition, which is three of FR-7.1's three occasions minus
 * one: see {@link deriveCommitOccasion} for the one the marker cannot answer.
 */

/**
 * What the marker said, read as an occasion.
 *
 * `undecidable` is a separate answer from an occasion the gate will refuse,
 * because the two are different facts: the second is a commit asked for at the
 * wrong moment, and the first is a commit asked for from a state that names no
 * moment at all. Collapsing them would report a marker problem as a discipline
 * problem.
 */
export type OccasionDerivation =
  | { readonly kind: 'derived'; readonly occasion: CommitOccasion }
  | { readonly kind: 'undecidable'; readonly reason: string };

/** Stated once, so the derivation and its refusal cannot describe different rules. */
const RULE = `A commit is created at a job boundary, which is EXECUTING carrying a job index; at the closure of a tour, which is CLOSING; or once as a WIP commit when stopping with unfinished work, which announces itself with a subject beginning ${JSON.stringify(WIP_SUBJECT_PREFIX)} (FR-7.1, SDD §4.5, BACKLOG D-105)`;

/**
 * The occasion this commit is being made on.
 *
 * Three occasions and two sources. Two of them are read off the marker, which
 * is the orchestrator's own record of where it is and is written by the
 * orchestrator alone (D-47), so a session cannot move it to reach an occasion
 * it is not at.
 *
 * The third cannot be. A stop condition is a decision the session takes inside
 * `EXECUTING` (§4.2), and no field of the marker changes when it does: a tour
 * stopping with unfinished work and a tour at a job boundary read identically.
 * So the WIP stop is recognised from the request, by the subject prefix the
 * loop itself writes when it asks for that commit (`run.ts`). That is the
 * request naming which question to ask, not the committer answering it: every
 * condition of the occasion stays observed from the repository, and the check
 * a WIP stop skips, the green run, is bought at the price of a branch other
 * than `default_branch` and one such commit per stop, both of which the gate
 * reads from `.git` (§4.5).
 *
 * The subject is checked before the marker, because a stop happens in
 * `EXECUTING` and `EXECUTING` also derives the boundary: asking the marker
 * first would make the stop unreachable.
 */
export function deriveCommitOccasion(
  marker: StateMarker,
  subject: string | null,
): OccasionDerivation {
  if (subject?.trimStart().startsWith(WIP_SUBJECT_PREFIX) === true) {
    const occasion: WipStopOccasion = {
      kind: 'wip-stop',
      reason: subject.trimStart().slice(WIP_SUBJECT_PREFIX.length).trim(),
    };
    return { kind: 'derived', occasion };
  }

  if (marker.state === 'EXECUTING') {
    if (marker.jobIndex === null) {
      return {
        kind: 'undecidable',
        reason: `the marker reads EXECUTING with no job index, so it names no boundary to commit at. ${RULE}.`,
      };
    }
    if (marker.tourId === null) {
      return {
        kind: 'undecidable',
        reason: `the marker reads EXECUTING with no tour, and a job boundary belongs to a tour. ${RULE}.`,
      };
    }
    const occasion: JobBoundaryOccasion = {
      kind: 'job-boundary',
      tourId: marker.tourId,
      jobIndex: marker.jobIndex,
    };
    return { kind: 'derived', occasion };
  }

  if (marker.state === 'CLOSING') {
    if (marker.tourId === null) {
      return {
        kind: 'undecidable',
        reason: `the marker reads CLOSING with no tour, and a closure closes one. ${RULE}.`,
      };
    }
    if (marker.disposition === null) {
      // The marker's own schema forbids this shape (§3.3, D-101), so reaching
      // it means the marker was written by something other than the machine.
      // Refusing is the only answer available: deriving `closed` here would
      // record a disposition nothing decided, on the one commit of a tour that
      // carries its documents.
      return {
        kind: 'undecidable',
        reason: `the marker reads CLOSING with no disposition, which is a shape the marker schema forbids (SDD §3.3, D-101). ${RULE}.`,
      };
    }
    const occasion: ClosureOccasion = {
      kind: 'closure',
      tourId: marker.tourId,
      state: marker.state,
      disposition: marker.disposition,
    };
    return { kind: 'derived', occasion };
  }

  return {
    kind: 'undecidable',
    reason: `the marker reads ${marker.state}, which is not an occasion to commit on. ${RULE}.`,
  };
}
