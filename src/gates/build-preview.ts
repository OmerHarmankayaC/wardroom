import type { ProjectConfig } from '../config/schema.js';
import type { RoleName } from '../roles/schema.js';
import { commitsNotOnRemote } from '../state/git.js';
import type { StateMarker } from '../state/marker.js';
import { type ToolCallClassification, pathsInCommand } from './classify.js';
import type { GatePreview } from './schema.js';

/**
 * The class-mandated preview, built from what the call said and what the
 * repository holds (SDD §3.1, §4.2).
 *
 * The classifier cannot build one: a push preview needs the commit list, which
 * needs the repository, and every preview needs to know which tour and which
 * role is asking. So the interceptor takes this as an input and the
 * orchestrator supplies it, which is the seam this module fills.
 *
 * Nothing here paraphrases the call. §3.1's fields are facts the owner decides
 * on, and a field that could only be filled by guessing at intent was removed
 * from the schema rather than filled in (D-54, D-32).
 */

/**
 * The role that made the call, read from the state rather than passed in.
 *
 * D-99 puts one session inside one state, so the state names the role: the
 * Implementer holds `EXECUTING` and the PM holds `PLANNING` and `CLOSING`. It
 * is read this way so one interceptor can serve both roles, which is what
 * makes neither of them intercepted less than the other (D-43).
 */
export function roleInState(marker: StateMarker): RoleName {
  const state =
    marker.state === 'GATED' || marker.state === 'PARKED'
      ? (marker.interruptedState ?? marker.state)
      : marker.state;
  return state === 'EXECUTING' ? 'implementer' : 'pm';
}

export interface PreviewBuilderInput {
  readonly root: string;
  readonly config: ProjectConfig;
  /** The marker as the orchestrator holds it: the tour, the job and the state. */
  readonly marker: () => StateMarker;
}

/**
 * Builds the preview for one classified call.
 *
 * `deployment` never arrives here, because nothing classifies one: a deploy
 * command is whatever the project says it is and the contract has no field
 * that says so (§3.1's classifier notes). It is refused rather than given an
 * invented preview, so the gap stays visible instead of being papered over
 * with a guess the owner would read as a fact.
 */
export function createPreviewBuilder(
  input: PreviewBuilderInput,
): (classification: ToolCallClassification) => GatePreview {
  return (classification) => {
    const marker = input.marker();

    switch (classification.detail.kind) {
      case 'push': {
        const remote = classification.detail.remote ?? 'origin';
        const branch = classification.detail.branch ?? input.config.defaultBranch;
        return {
          kind: 'push',
          commits: commitsNotOnRemote(input.root, remote, branch),
          remote,
          branch,
        };
      }
      case 'destructive':
        return {
          kind: 'destructive',
          command: classification.detail.command,
          affects: pathsInCommand(classification.detail.command),
        };
      case 'secrets':
        return {
          kind: 'secrets',
          secret: classification.detail.secret,
          role: roleInState(marker),
          // The job it was raised from, as the block numbers it. Null before a
          // tour record exists, which is a fact rather than a missing field
          // (D-45, D-70, D-32).
          job: marker.tourId === null ? null : `${marker.tourId} job ${marker.jobIndex ?? 0}`,
          call: classification.detail.call,
        };
    }
  };
}
