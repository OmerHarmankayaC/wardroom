import type { TourState } from '../state/marker.js';
import type { GateClass, GateEntry } from './schema.js';

/**
 * The FR-3.3 notification: the owner is told that a tour was parked and why.
 *
 * Delivery is best-effort and surface-dependent, because a detached CLI cannot
 * push anything anywhere. The durable record is the gate entry on disk, never
 * this: a notification that never arrived does not change what happens when the
 * owner returns (SDD §3.2).
 *
 * What the notification carries is a decision the owner can act on, in language
 * they can act on (FR-3.4). It does not carry the preview: the preview is
 * evidence to inspect at the gate, and evidence pushed into a notification is
 * evidence read in the wrong place.
 */
export interface ParkedNotification {
  readonly kind: 'tour-parked';
  readonly gateId: string;
  readonly gateClass: GateClass;
  /** Null for a gate raised before any tour record exists (SDD §3.1, D-70). */
  readonly tourId: string | null;
  readonly what: string;
  readonly why: string;
  /** The state the tour returns to once the owner decides (SDD §3.2). */
  readonly interruptedState: TourState;
  readonly parkedAt: string;
  /** The waiting period that elapsed, as the contract writes it, e.g. `24h`. */
  readonly waited: string;
}

export type Notifier = (notification: ParkedNotification) => void;

/**
 * Describes a parked entry.
 *
 * An entry with no `parked_at` is refused rather than described: saying a tour
 * was parked when nothing on disk says so would make the notification the
 * record, and it is expressly not the record.
 */
export function parkedNotification(entry: GateEntry, waited: string): ParkedNotification {
  if (entry.parkedAt === null) {
    throw new Error(
      `gate ${entry.gateId} carries no parked_at, so there is no parking to notify anyone about.`,
    );
  }

  return {
    kind: 'tour-parked',
    gateId: entry.gateId,
    gateClass: entry.gateClass,
    tourId: entry.tourId,
    what: entry.what,
    why: entry.why,
    interruptedState: entry.interruptedState,
    parkedAt: entry.parkedAt,
    waited,
  };
}

/**
 * Hands the notification to the surface, and reports whether it got there.
 *
 * Nothing a notifier does escapes: a surface that throws is a surface that did
 * not deliver, and the parking it was told about has already happened on disk.
 * Letting the throw out would unwind the one caller that must not unwind.
 */
export function deliver(notifier: Notifier | undefined, notification: ParkedNotification): boolean {
  if (notifier === undefined) return false;
  try {
    notifier(notification);
    return true;
  } catch {
    return false;
  }
}
