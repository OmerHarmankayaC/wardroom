import { isFilledString, isJsonObject } from '../json/guards.js';
import { TREE_CHANGE_TYPES } from '../state/git.js';
import { GATE_CLASSES, type GateClass, type GatePreview } from './schema.js';

/**
 * The per-class preview contract (SDD §3.1).
 *
 * A gate without its preview is not presentable and MUST NOT be enqueued: an
 * owner asked to approve an action they cannot inspect will approve it
 * blindly, which defeats the gate. So this module answers with a *reason*
 * rather than a boolean. A refusal without a stated reason is the same
 * operational dead end a silent default is, which is why ConfigError carries
 * its problems too.
 */

/** Reports a missing or blank string field. */
function checkText(source: Record<string, unknown>, field: string, problems: string[]): void {
  if (!isFilledString(source[field])) {
    problems.push(
      `preview.${field}: must be a non-empty string, describing what the owner approves.`,
    );
  }
}

/**
 * Reports a list that is absent, not a list, or holds a blank entry.
 * `allowEmpty` is for the one field where emptiness is itself the evidence.
 */
function checkTextList(
  source: Record<string, unknown>,
  field: string,
  problems: string[],
  allowEmpty = false,
): void {
  const value = source[field];
  if (!Array.isArray(value)) {
    problems.push(`preview.${field}: must be a list.`);
    return;
  }
  if (value.length === 0 && !allowEmpty) {
    problems.push(`preview.${field}: is empty, so the preview shows the owner nothing.`);
    return;
  }
  value.forEach((entry, index) => {
    if (!isFilledString(entry))
      problems.push(`preview.${field}[${index}]: must be a non-empty string.`);
  });
}

function checkPush(preview: Record<string, unknown>, problems: string[]): void {
  const commits = preview.commits;
  if (!Array.isArray(commits)) {
    problems.push('preview.commits: must be a list of commits, hash and subject each.');
  } else if (commits.length === 0) {
    problems.push(
      'preview.commits: is empty, and a push of no commits is not an action to approve.',
    );
  } else {
    commits.forEach((commit, index) => {
      if (
        !isJsonObject(commit) ||
        !isFilledString(commit.hash) ||
        !isFilledString(commit.subject)
      ) {
        problems.push(`preview.commits[${index}]: must carry a non-empty hash and subject.`);
      }
    });
  }
  checkText(preview, 'remote', problems);
  checkText(preview, 'branch', problems);
}

function checkDeployment(preview: Record<string, unknown>, problems: string[]): void {
  checkText(preview, 'environment', problems);
  checkTextList(preview, 'changedServices', problems);
  // The one list allowed to be empty: "no migration is pending" is information
  // the owner needs, and refusing it would make an ordinary deployment
  // unpresentable. Absence of the field is still a refusal.
  checkTextList(preview, 'pendingMigrations', problems, true);
}

function checkScopeChange(preview: Record<string, unknown>, problems: string[]): void {
  const sections = preview.sections;
  if (!Array.isArray(sections)) {
    problems.push('preview.sections: must be the proposed document diff, section by section.');
    return;
  }
  if (sections.length === 0) {
    problems.push('preview.sections: is empty, so no document change is shown.');
    return;
  }
  sections.forEach((section, index) => {
    if (
      !isJsonObject(section) ||
      !isFilledString(section.document) ||
      !isFilledString(section.section) ||
      !isFilledString(section.diff)
    ) {
      problems.push(`preview.sections[${index}]: must name a document, a section, and its diff.`);
    }
  });
}

function checkDestructive(preview: Record<string, unknown>, problems: string[]): void {
  checkText(preview, 'command', problems);
  checkTextList(preview, 'affects', problems);
}

function checkSecrets(preview: Record<string, unknown>, problems: string[]): void {
  checkText(preview, 'secret', problems);
  checkText(preview, 'purpose', problems);
  if (preview.access !== 'read' && preview.access !== 'write') {
    problems.push('preview.access: must be read or write.');
  }
  // SDD §3.1 says which secret and for what purpose, never the value. A
  // preview carrying one would put a secret into a file whose whole job is to
  // be read by a human and kept until it is answered.
  if ('value' in preview) {
    problems.push('preview.value: a secrets preview never carries the secret itself (SDD §3.1).');
  }
}

function checkTourBudget(preview: Record<string, unknown>, problems: string[]): void {
  if (!Number.isInteger(preview.attemptCount) || (preview.attemptCount as number) < 1) {
    problems.push('preview.attemptCount: must be the number of attempts made, at least one.');
  }
  checkText(preview, 'lastFailureOutput', problems);
}

function checkDirtyTree(preview: Record<string, unknown>, problems: string[]): void {
  const changes = preview.changes;
  if (!Array.isArray(changes)) {
    problems.push('preview.changes: must be the changed paths, each with its change type (D-36).');
    return;
  }
  if (changes.length === 0) {
    // Not one of the two D-32 exceptions: an empty list means the tree is
    // clean and the gate should not have been raised, so refusing catches a
    // bug upstream rather than asking the owner to approve nothing.
    problems.push(
      'preview.changes: is empty, and a clean tree raises no dirty-tree gate (D-32, D-36).',
    );
    return;
  }
  changes.forEach((change, index) => {
    if (!isJsonObject(change) || !isFilledString(change.path)) {
      problems.push(`preview.changes[${index}]: must carry the changed path.`);
      return;
    }
    if (!(TREE_CHANGE_TYPES as readonly unknown[]).includes(change.changeType)) {
      problems.push(
        `preview.changes[${index}]: changeType must be one of ${TREE_CHANGE_TYPES.join(', ')} (D-36).`,
      );
    }
  });
}

const CHECKS: Record<GateClass, (preview: Record<string, unknown>, problems: string[]) => void> = {
  push: checkPush,
  deployment: checkDeployment,
  'scope-change': checkScopeChange,
  destructive: checkDestructive,
  secrets: checkSecrets,
  'tour-budget': checkTourBudget,
  'dirty-tree': checkDirtyTree,
};

/**
 * Returns why this preview cannot be presented for this class, or null when it
 * can. Every problem found is reported at once, for the same reason the config
 * loader reports all of them: fixing one field to be told about the next is
 * how a five minute correction becomes an afternoon.
 */
export function previewProblem(gateClass: GateClass, preview: unknown): string | null {
  if (!GATE_CLASSES.includes(gateClass)) {
    return `class: must be one of ${GATE_CLASSES.join(', ')} (SRS TD-2).`;
  }
  if (!isJsonObject(preview)) {
    return `preview: missing. A ${gateClass} gate is not presentable without one (SDD §3.1).`;
  }
  if (preview.kind !== gateClass) {
    return `preview.kind: a ${gateClass} gate carries a ${gateClass} preview, got ${JSON.stringify(preview.kind) ?? 'nothing'}.`;
  }

  const problems: string[] = [];
  CHECKS[gateClass](preview, problems);
  return problems.length === 0 ? null : problems.join(' ');
}

/** Narrows a preview already proven presentable by {@link previewProblem}. */
export function asPreview(gateClass: GateClass, preview: unknown): GatePreview {
  const problem = previewProblem(gateClass, preview);
  if (problem !== null) throw new Error(problem);
  return preview as GatePreview;
}
