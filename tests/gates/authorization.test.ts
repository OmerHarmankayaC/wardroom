import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import { readAuditLines } from '../../src/gates/audit.js';
import {
  type EnqueueRequest,
  GateRefusedError,
  authorizationFor,
  consume,
  decide,
  enqueue,
} from '../../src/gates/queue.js';

/**
 * An approval authorizes one call and is consumed by it (SRS FR-3.1, SDD §3.2,
 * D-61).
 *
 * The session that asked does not survive a park, so the approved action is
 * taken by a later session. Without this rule the later session's identical
 * call raises the same gate a second time, which §4.4 forbids, or the decided
 * entry stands as a permanent permission for an action the owner approved
 * once.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-authorization-'));
  mkdirSync(wardroomPaths(root).gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const PUSH = 'Run `git push origin main`';

function request(overrides: Partial<EnqueueRequest> = {}): EnqueueRequest {
  return {
    gateClass: 'push',
    tourId: 'tour-9',
    jobIndex: 3,
    interruptedState: 'EXECUTING',
    what: PUSH,
    why: 'TD-2 classifies git push and remote operations as critical actions',
    preview: {
      kind: 'push',
      commits: [{ hash: 'abc1234', subject: 'feat: one' }],
      remote: 'origin',
      branch: 'main',
    },
    ...overrides,
  };
}

/** An approved entry, as the owner would leave one behind. */
function approved(overrides: Partial<EnqueueRequest> = {}): string {
  const entry = enqueue(root, request(overrides));
  decide(root, entry.gateId, 'approved', 'owner');
  return entry.gateId;
}

function look(overrides: Partial<{ gateClass: string; what: string; tourId: string }> = {}) {
  return authorizationFor(root, {
    gateClass: 'push',
    what: PUSH,
    tourId: 'tour-9',
    ...overrides,
  } as Parameters<typeof authorizationFor>[1]);
}

describe('an approved entry authorizes the call it names', () => {
  it('is found for a matching call', () => {
    const gateId = approved();

    expect(look()?.gateId).toBe(gateId);
  });

  it('is not found for a different class', () => {
    approved();

    expect(look({ gateClass: 'destructive' })).toBeNull();
  });

  it('is not found for a different call of the same class', () => {
    approved();

    expect(look({ what: 'Run `git push origin release`' })).toBeNull();
  });

  it('is not found while the owner has not answered', () => {
    enqueue(root, request());

    expect(look()).toBeNull();
  });

  it('is not found when the owner rejected it', () => {
    const entry = enqueue(root, request());
    decide(root, entry.gateId, 'rejected', 'owner');

    // A rejection authorizes nothing. Reusing one to deny a later identical
    // call quietly would answer for the owner just as reusing an approval
    // would, and §3.2 routes a rejection to a new job instead.
    expect(look()).toBeNull();
  });
});

describe('the authorization is spent by the call that uses it', () => {
  it('appends a consumed line naming the call', () => {
    const gateId = approved();

    consume(root, gateId, PUSH);

    const lines = readAuditLines(root);
    expect(lines.map((line) => line.event)).toEqual(['enqueued', 'decided', 'consumed']);
    expect(lines[2]?.gateId).toBe(gateId);
    expect(lines[2]?.payload.what).toBe(PUSH);
  });

  it('stops authorizing anything once it is spent', () => {
    const gateId = approved();
    consume(root, gateId, PUSH);

    expect(look()).toBeNull();
  });

  it('refuses to be spent twice, because the second call was never approved', () => {
    const gateId = approved();
    consume(root, gateId, PUSH);

    expect(() => consume(root, gateId, PUSH)).toThrowError(GateRefusedError);
  });

  it('refuses to spend an entry the owner has not approved', () => {
    const entry = enqueue(root, request());

    expect(() => consume(root, entry.gateId, PUSH)).toThrowError(GateRefusedError);
  });

  it('records the consumption in the log and nowhere else', () => {
    // The entry schema (§3.1) has no field for it, and the audit log is
    // described as the only evidence that an approval was spent rather than
    // still standing. One fact, one home.
    const gateId = approved();
    const before = JSON.stringify(look());

    consume(root, gateId, PUSH);

    expect(before).not.toBe('null');
    expect(readAuditLines(root).some((line) => line.event === 'consumed')).toBe(true);
  });
});

describe('an unconsumed authorization does not survive the cycle', () => {
  it('is not found from a later tour', () => {
    approved();

    expect(look({ tourId: 'tour-10' })).toBeNull();
  });

  it('is not found once the cycle has reached IDLE and carries no tour', () => {
    // At IDLE the marker carries no tour_id, so nothing an earlier cycle
    // approved can match. The lapse needs no event of its own: the entry is
    // scoped to the cycle that raised it (§3.2, D-61).
    approved();

    expect(look({ tourId: '' })).toBeNull();
  });

  it('still holds inside the cycle that raised it, across a death', () => {
    // The whole point of D-61: the session that asked does not survive a park,
    // and the later session in the same cycle is the one that acts.
    const gateId = approved();

    expect(look()?.gateId).toBe(gateId);
  });

  it('scopes by an exact comparison, with no special case for any class', () => {
    // Every class is scoped the same way, including the ones raised before a
    // tour record exists (D-45). Those carry an empty tour_id, and an empty
    // string compares like any other value here rather than through an
    // exception nobody would remember to keep in step.
    const destructive: Partial<EnqueueRequest> = {
      gateClass: 'destructive',
      what: 'Run `rm -rf build`',
      preview: { kind: 'destructive', command: 'rm -rf build', affects: ['build'] },
    };
    const gateId = approved(destructive);

    expect(look({ gateClass: 'destructive', what: 'Run `rm -rf build`' })?.gateId).toBe(gateId);
    expect(look({ gateClass: 'destructive', what: 'Run `rm -rf build`', tourId: '' })).toBeNull();
  });
});
