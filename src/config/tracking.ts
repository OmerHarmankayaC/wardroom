/**
 * The tracking policy (SRS §3.7, SDD §3.4, BACKLOG D-15).
 *
 * Two categories fail differently. The project contract — `.wardroom/config.json`
 * and the canonical documents — is what makes a repository a managed project;
 * a clone that cannot state its own green definition can verify nothing, so it
 * is tracked always and by no setting excluded. Runtime records under
 * `.wardroom/run/` are tracked by default and may be excluded by an owner who
 * keeps process artefacts out of a public repository, at the cost of a
 * machine-local audit trail (BACKLOG T-4).
 *
 * `track_runtime: false` therefore governs exactly one path.
 */

/** The single path `track_runtime: false` excludes. Never widened. */
export const RUNTIME_IGNORE_ENTRY = '.wardroom/run/';

/** The ignore entries the tracking policy calls for. One, or none. */
export function runtimeIgnoreEntries(trackRuntime: boolean): readonly string[] {
  return trackRuntime ? [] : [RUNTIME_IGNORE_ENTRY];
}

/**
 * Returns the ignore file with the tracking policy applied.
 *
 * Additive by design: it appends the runtime entry when it is missing and
 * touches nothing else. Removing lines would put Wardroom in the business of
 * editing a file the owner owns, and the one line it is entitled to add is the
 * one line it adds.
 */
export function applyTrackingPolicy(gitignore: string, trackRuntime: boolean): string {
  const existing = gitignore.split('\n').map((line) => line.trim());
  const missing = runtimeIgnoreEntries(trackRuntime).filter((entry) => !existing.includes(entry));
  if (missing.length === 0) return gitignore;

  const separator = gitignore === '' || gitignore.endsWith('\n') ? '' : '\n';
  return `${gitignore}${separator}${missing.join('\n')}\n`;
}
