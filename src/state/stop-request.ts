import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { ensureRunDir, wardroomPaths } from '../config/paths.js';

/**
 * The cooperative stop request (SDD §5.1, FR-1.2, D-83, D-106).
 *
 * `detach` is a cooperative stop and never a kill. It asks the loop to stop at
 * the next job boundary, which is the only place where stopping costs nothing:
 * the work is committed, the marker is current, and `run` resumes from it by
 * the ordinary resumption path (§4.4). A detach mid job would discard exactly
 * the work a boundary exists to protect.
 *
 * The request is a file. `run` holds the terminal, so `detach` is a second
 * process, and a second process cannot call into the first: no signal, no
 * socket, no pid, because durable state lives in repository files (TD-3) and a
 * request that survives a crash is the same request a boundary honours.
 *
 * It lives here rather than beside either of its two users because both of
 * them need it and neither may import the other: the operation writes it
 * (../api/project.ts) and the loop reads and clears it (../loop/run.ts).
 */

/** Writes the request. Its presence is the whole of it, so it carries no contents. */
export function requestStop(root: string): void {
  ensureRunDir(root);
  writeFileSync(wardroomPaths(root).stopRequestFile, '');
}

/** Whether a stop has been asked for and not yet honoured. */
export function stopRequested(root: string): boolean {
  return existsSync(wardroomPaths(root).stopRequestFile);
}

/**
 * Removes the request.
 *
 * Two callers, for two reasons that are the same reason seen twice. Honouring
 * a stop clears it, because a request acted on is answered. And a run clears
 * whatever it finds at startup, because a request written before this run
 * began was aimed at a run that is already gone: without that, a detach nobody
 * honoured would stop the next tour at its first boundary, for a reason nobody
 * could see.
 *
 * Removing one that is not there is not an error. The caller's question is
 * whether a request stands afterwards, and it does not either way.
 */
export function clearStopRequest(root: string): void {
  rmSync(wardroomPaths(root).stopRequestFile, { force: true });
}
