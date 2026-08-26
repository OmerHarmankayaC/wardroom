import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Which project a command acts on (SDD §5.2, D-109).
 *
 * The nearest ancestor of the working directory containing
 * `.wardroom/config.json`, overridable with `--project <path>`.
 *
 * Not the working directory itself, because the owner is usually somewhere
 * inside the repository when a gate arrives. Not an ambient default and not a
 * remembered last project, because a command that acts on a project the owner
 * did not name and cannot see is the shape every destructive accident in a
 * multi-project setup takes.
 *
 * Where no project is found the command exits 1 and says which directory it
 * searched from, because "no project found" without that is unactionable: the
 * owner cannot tell a wrong directory from a missing file.
 */

/** The file whose presence makes a directory a project (SDD §3.0). */
export const PROJECT_MARKER = join('.wardroom', 'config.json');

export type ProjectResolution =
  | { readonly kind: 'found'; readonly root: string }
  | { readonly kind: 'not-found'; readonly message: string };

function holdsProject(directory: string): boolean {
  return existsSync(join(directory, PROJECT_MARKER));
}

/**
 * Resolves the project, or says where it looked.
 *
 * An override is taken literally: it names the project, and it is not a second
 * starting point for the same upward search. An owner who names a directory
 * has said which project they mean, and searching past it would act on a
 * different one than the one they named, which is the accident this whole
 * rule exists to prevent.
 */
export function resolveProject(cwd: string, override: string | null): ProjectResolution {
  if (override !== null) {
    const named = resolve(cwd, override);
    if (holdsProject(named)) return { kind: 'found', root: named };
    return {
      kind: 'not-found',
      message: `${named} was named with --project and holds no ${PROJECT_MARKER}, so it is not a Wardroom project.`,
    };
  }

  const from = resolve(cwd);
  let directory = from;
  for (;;) {
    if (holdsProject(directory)) return { kind: 'found', root: directory };
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return {
    kind: 'not-found',
    message: `no Wardroom project was found: no directory from ${from} up to the filesystem root holds ${PROJECT_MARKER}. Name one with --project <path>.`,
  };
}
