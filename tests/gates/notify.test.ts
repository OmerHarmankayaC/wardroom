import { describe, expect, it } from 'vitest';
import { deliver, parkedNotification } from '../../src/gates/notify.js';
import type { GateEntry } from '../../src/gates/schema.js';

/**
 * The FR-3.3 notification: the owner is told a tour was parked and why.
 *
 * Delivery is best-effort and surface-dependent, and the durable record is the
 * gate entry, never the notification. So the property that matters most here is
 * the negative one: nothing a notifier does can change what parking did.
 */

const parked = {
  gateId: 'g-20260821T090000Z-a3f9',
  gateClass: 'push',
  status: 'pending',
  tourId: 'tour-3-b-i',
  jobIndex: 3,
  interruptedState: 'EXECUTING',
  what: 'Run `git push origin main`',
  why: 'TD-2 classifies git push and remote operations as critical actions',
  parkedAt: '2026-08-22T09:00:00.000Z',
} as GateEntry;

describe('the notification says a tour was parked and why', () => {
  it('carries what the owner needs in order to act on it', () => {
    expect(parkedNotification(parked, '24h')).toEqual({
      kind: 'tour-parked',
      gateId: 'g-20260821T090000Z-a3f9',
      gateClass: 'push',
      tourId: 'tour-3-b-i',
      what: 'Run `git push origin main`',
      why: 'TD-2 classifies git push and remote operations as critical actions',
      interruptedState: 'EXECUTING',
      parkedAt: '2026-08-22T09:00:00.000Z',
      waited: '24h',
    });
  });

  it('refuses to describe an entry that was never parked', () => {
    expect(() => parkedNotification({ ...parked, parkedAt: null }, '24h')).toThrowError();
  });
});

describe('delivery is best-effort', () => {
  it('passes the notification to the notifier', () => {
    const seen: unknown[] = [];

    expect(
      deliver((notification) => seen.push(notification), parkedNotification(parked, '24h')),
    ).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it('reports a notifier that threw without letting it escape', () => {
    // A detached CLI cannot push a notification, and a surface that fails must
    // not undo the parking that already happened on disk.
    expect(
      deliver(
        () => {
          throw new Error('no surface attached');
        },
        parkedNotification(parked, '24h'),
      ),
    ).toBe(false);
  });

  it('reports no delivery when there is no notifier at all', () => {
    expect(deliver(undefined, parkedNotification(parked, '24h'))).toBe(false);
  });
});
