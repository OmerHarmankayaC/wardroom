import type { TourState } from '../state/marker.js';
import { readAuditLines, recordThenAct } from './audit.js';
import { mintGateId } from './id.js';
import { asPreview, previewProblem } from './preview.js';
import type { GateClass, GateEntry, GatePreview } from './schema.js';
import { listEntryIds, readEntry, writeEntry } from './store.js';

/**
 * The gate queue operations behind SDD §5.1's `gate.list`, `gate.show` and
 * `gate.decide`, plus the enqueue and park sides the orchestrator drives.
 *
 * This is a data layer. Blocking a tour on an entry, parking it when
 * `gate_wait` elapses, and the FR-3.3 notification belong to the orchestration
 * loop; what is here is what those read and write.
 *
 * Every mutating operation runs in the same order: refuse, then record, then
 * write. Refusing first means a refused request leaves no trace of an action
 * that never happened; recording before writing means a crash leaves evidence
 * rather than silence (SDD §3.1). The order is held by {@link recordThenAct}
 * rather than by each function remembering it.
 */

export interface EnqueueRequest {
  readonly gateClass: GateClass;
  /** Null where no tour record exists yet; see {@link GateEntry.tourId} (D-70). */
  readonly tourId: string | null;
  readonly jobIndex: number | null;
  readonly interruptedState: TourState;
  readonly what: string;
  readonly why: string;
  readonly preview: GatePreview;
}

export interface QueueOptions {
  readonly now?: Date;
  /** Injected by tests that need a known identifier; nothing in the product passes it. */
  readonly randomHex?: () => string;
}

/** An operation the queue will not perform, with the reason it will not. */
export class GateRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'GateRefusedError';
    this.reason = reason;
  }
}

export class GateNotFoundError extends Error {
  readonly gateId: string;

  constructor(gateId: string) {
    super(`no gate ${gateId} in this repository.`);
    this.name = 'GateNotFoundError';
    this.gateId = gateId;
  }
}

export class GateAlreadyDecidedError extends Error {
  readonly gateId: string;
  readonly status: 'approved' | 'rejected';

  constructor(gateId: string, status: 'approved' | 'rejected', decidedBy: string | null) {
    super(
      `gate ${gateId} was already ${status} by ${decidedBy ?? 'someone'}; a decision is made once and is not revised in place.`,
    );
    this.name = 'GateAlreadyDecidedError';
    this.gateId = gateId;
    this.status = status;
  }
}

/**
 * Records a pending critical decision and returns the entry as written.
 *
 * A gate whose class-mandated preview is missing or empty is refused here and
 * no file is written: an entry that reaches disk is an entry an owner can be
 * asked to answer, and one they cannot inspect they would answer blindly
 * (SDD §3.1).
 */
export function enqueue(
  root: string,
  request: EnqueueRequest,
  options: QueueOptions = {},
): GateEntry {
  const problem = previewProblem(request.gateClass, request.preview);
  if (problem !== null) {
    throw new GateRefusedError(
      `a ${request.gateClass} gate cannot be enqueued without its preview: ${problem}`,
    );
  }
  if (request.what.trim() === '') {
    throw new GateRefusedError('a gate states what is being requested, in one line.');
  }
  if (request.why.trim() === '') {
    throw new GateRefusedError('a gate states the rule that classified it as one.');
  }

  const now = options.now ?? new Date();
  const entry: GateEntry = {
    gateId: mintGateId(now, options.randomHex),
    gateClass: request.gateClass,
    status: 'pending',
    tourId: request.tourId,
    jobIndex: request.jobIndex,
    interruptedState: request.interruptedState,
    what: request.what,
    why: request.why,
    preview: asPreview(request.gateClass, request.preview),
    requestedAt: now.toISOString(),
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    parkedAt: null,
  };

  return recordThenAct(
    root,
    {
      ts: entry.requestedAt,
      gateId: entry.gateId,
      event: 'enqueued',
      payload: {
        class: entry.gateClass,
        tour_id: entry.tourId,
        job_index: entry.jobIndex,
        what: entry.what,
      },
    },
    () => {
      writeEntry(root, entry);
      return entry;
    },
  );
}

/**
 * The gates awaiting an answer, oldest first.
 *
 * The default filter is `status === 'pending'` and nothing more. A parked gate
 * IS a pending gate with `parked_at` set (BACKLOG D-27), so "pending and
 * parked" is one predicate rather than two. If this ever needs a second
 * clause, the status model has drifted back to the four-state version D-27
 * removed.
 *
 * Resolved entries stay in the directory because v1 does not archive (D-29);
 * `includeResolved` is how a caller asks for them, and {@link show} always
 * answers for one asked for by identifier.
 */
export function list(
  root: string,
  options: { readonly includeResolved?: boolean } = {},
): GateEntry[] {
  const entries = listEntryIds(root)
    .map((gateId) => readEntry(root, gateId))
    .filter((entry): entry is GateEntry => entry !== null);

  return options.includeResolved === true
    ? entries
    : entries.filter((entry) => entry.status === 'pending');
}

/** One gate with its full preview, resolved or not (SDD §5.1, D-29). */
export function show(root: string, gateId: string): GateEntry {
  const entry = readEntry(root, gateId);
  if (entry === null) throw new GateNotFoundError(gateId);
  return entry;
}

/**
 * Records the owner's decision. A gate is answered once: a second decision is
 * refused rather than overwriting the first, because the first is what the
 * orchestrator already acted on.
 */
export function decide(
  root: string,
  gateId: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  note: string | null = null,
  options: QueueOptions = {},
): GateEntry {
  const entry = show(root, gateId);
  if (entry.status !== 'pending') {
    throw new GateAlreadyDecidedError(gateId, entry.status, entry.decidedBy);
  }
  if (decidedBy.trim() === '') {
    throw new GateRefusedError('a decision records who made it (FR-3.2).');
  }

  const decidedAt = (options.now ?? new Date()).toISOString();
  const decided: GateEntry = {
    ...entry,
    status: decision,
    decidedAt,
    decidedBy,
    decisionNote: note,
  };

  return recordThenAct(
    root,
    {
      ts: decidedAt,
      gateId,
      event: 'decided',
      payload: { status: decision, decided_by: decidedBy, decision_note: note },
    },
    () => {
      writeEntry(root, decided);
      return decided;
    },
  );
}

/**
 * Stamps the gate as parked because its waiting period elapsed (FR-3.3).
 *
 * `status` is untouched. Expiry releases the orchestrator; it never approves,
 * rejects, or otherwise decides the action, so a parked gate is answered by
 * the owner exactly as a fresh one is (SDD §3.2, D-27).
 */
export function park(root: string, gateId: string, options: QueueOptions = {}): GateEntry {
  const entry = show(root, gateId);
  if (entry.status !== 'pending') {
    throw new GateRefusedError(
      `gate ${gateId} was already ${entry.status}; parking releases the orchestrator from a gate still waiting, and this one is answered.`,
    );
  }
  if (entry.parkedAt !== null) {
    throw new GateRefusedError(
      `gate ${gateId} was parked at ${entry.parkedAt}; a second stamp would move the record of when the wait actually elapsed.`,
    );
  }

  const parkedAt = (options.now ?? new Date()).toISOString();
  const parked: GateEntry = { ...entry, parkedAt };

  return recordThenAct(
    root,
    { ts: parkedAt, gateId, event: 'parked', payload: { parked_at: parkedAt } },
    () => {
      writeEntry(root, parked);
      return parked;
    },
  );
}

/**
 * What a call has to match for an approval to authorize it (SDD §3.2, D-61).
 *
 * The class and the `what` line, which the classifier derives from the call
 * deterministically, so comparing `what` is comparing the call. D-61 says "the
 * call it recorded verbatim" and no entry field holds a call verbatim, the
 * `secrets` preview aside (D-54); `what` is what the entry actually records of
 * it. That gap is reported rather than papered over here.
 *
 * `tourId` scopes the authorization to the cycle that raised it. An
 * unconsumed authorization lapses when the cycle reaches `IDLE`, and this is
 * how: at `IDLE` the marker carries no tour, so nothing an earlier cycle
 * approved can match. The lapse needs no event of its own and leaves no
 * bookkeeping to get wrong.
 */
export interface AuthorizationQuery {
  readonly gateClass: GateClass;
  readonly what: string;
  /**
   * The cycle asking, or null where no tour record exists yet (D-45, D-70).
   *
   * Compared as it is, never coerced. Turning a null into an empty string
   * would make it match nothing at all, which reads as "the approval lapsed"
   * when the truth is "the question was asked wrongly".
   */
  readonly tourId: string | null;
}

/**
 * The gates the audit log records as already spent.
 *
 * Read once per question rather than once per candidate. Re-reading inside a
 * loop is not only wasteful: the log is append-only and another process may be
 * writing to it, so a query that read it repeatedly could judge one entry
 * against a log that already held a line the next entry was judged without.
 */
function spentGates(root: string): Set<string> {
  const spent = new Set<string>();
  for (const line of readAuditLines(root)) {
    if (line.event === 'consumed') spent.add(line.gateId);
  }
  return spent;
}

/**
 * The approval standing for this call, or null.
 *
 * Only an approval authorizes. A rejection authorizes nothing and is not
 * reused to deny a later identical call either: that would answer for the
 * owner exactly as reusing an approval would, and §3.2 routes a rejection to a
 * new job instead.
 */
export function authorizationFor(root: string, query: AuthorizationQuery): GateEntry | null {
  const spent = spentGates(root);
  const standing = list(root, { includeResolved: true }).filter(
    (entry) =>
      entry.status === 'approved' &&
      entry.gateClass === query.gateClass &&
      entry.what === query.what &&
      entry.tourId === query.tourId &&
      !spent.has(entry.gateId),
  );

  // Oldest first, so an owner who answered twice has their first answer used
  // first rather than their most recent one.
  return standing[0] ?? null;
}

/**
 * The owner's refusal of exactly this question, or null (SDD §4.6 step 3,
 * D-79).
 *
 * Matched on the same key an approval is, the class and the `what` line and
 * the tour, for the same reason: nothing holds the question verbatim outside
 * the entry, and `what` is derived deterministically from it (§3.1, D-67).
 *
 * This is not the mirror of {@link authorizationFor} and must not be used as
 * one. An approval authorizes an action and is spent by it; a refusal
 * authorizes nothing and is never reused to deny a later call, which §3.2
 * routes to a new job instead. What a refusal settles is a closure debt, which
 * is a question about a document and not a call, and D-79 is the one place a
 * rejection means anything after the fact.
 */
export function refusalOf(root: string, query: AuthorizationQuery): GateEntry | null {
  const refused = list(root, { includeResolved: true }).filter(
    (entry) =>
      entry.status === 'rejected' &&
      entry.gateClass === query.gateClass &&
      entry.what === query.what &&
      entry.tourId === query.tourId,
  );
  // Oldest first, as above: an owner who answered twice has their first
  // answer read first.
  return refused[0] ?? null;
}

/**
 * Spends an approval on the call it authorized (SDD §3.2, D-61).
 *
 * The line goes into the audit log and nothing is written to the entry,
 * because the entry has no field for it and a second home for the fact would
 * be a second place for it to be wrong. Refused where the entry was never
 * approved or has already been spent: an authorization used twice is a
 * standing permission the owner never granted.
 */
export function consume(
  root: string,
  gateId: string,
  what: string,
  options: QueueOptions = {},
): GateEntry {
  const entry = show(root, gateId);
  if (entry.status !== 'approved') {
    throw new GateRefusedError(
      `gate ${gateId} is ${entry.status}, and only an approval authorizes a call (FR-3.1, D-61).`,
    );
  }
  if (spentGates(root).has(gateId)) {
    throw new GateRefusedError(
      `gate ${gateId} was already spent on the call it authorized; an approval authorizes one call and no more (SDD §3.2, D-61).`,
    );
  }

  const ts = (options.now ?? new Date()).toISOString();
  return recordThenAct(
    root,
    { ts, gateId, event: 'consumed', payload: { what, class: entry.gateClass } },
    () => entry,
  );
}
