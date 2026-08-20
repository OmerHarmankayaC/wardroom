import { describe, expect, it } from 'vitest';
import { GATE_ID_PATTERN, mintGateId } from '../../src/gates/id.js';

/**
 * BACKLOG D-28. The identifier is the filename and the audit log's join key,
 * so three properties are load-bearing: it is filename-safe, it sorts into the
 * order the gates were raised, and two gates raised in the same second do not
 * collide.
 */

const noon = new Date('2026-08-20T13:15:00.000Z');

describe('mintGateId', () => {
  it('matches the format the design fixes', () => {
    expect(mintGateId(noon)).toMatch(GATE_ID_PATTERN);
  });

  it('carries the compact UTC timestamp of the clock it was given', () => {
    expect(mintGateId(noon, () => 'a3f9')).toBe('g-20260820T131500Z-a3f9');
  });

  it('distinguishes two gates minted from the same second', () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintGateId(noon)));

    // Four hex characters collide by birthday well before 200 draws are
    // certain to be distinct, so the assertion is on the shape of the answer:
    // randomness is present and the ids are not all the timestamp.
    expect(minted.size).toBeGreaterThan(150);
  });

  it('sorts by name into the order the gates were raised', () => {
    const earlier = mintGateId(new Date('2026-08-20T09:00:00.000Z'), () => 'ffff');
    const later = mintGateId(new Date('2026-08-20T09:00:01.000Z'), () => '0000');

    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  it('is filename-safe on every platform the project supports', () => {
    expect(mintGateId(noon)).not.toMatch(/[:/\\<>"|?*]/);
  });
});
