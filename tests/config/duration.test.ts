import { describe, expect, it } from 'vitest';
import { DURATION_GRAMMAR, parseDuration } from '../../src/config/duration.js';

/**
 * BACKLOG D-22 and B-10. The field is hand-written in a hand-edited file, so
 * the grammar is deliberately small: one number, one unit, nothing else. What
 * the parser owes is that every form outside it is refused rather than
 * silently reinterpreted, because a gate that waits for the wrong length of
 * time parks a tour nobody expected to be parked.
 */

describe('parseDuration', () => {
  it('parses the project default', () => {
    expect(parseDuration('24h')).toEqual({ value: 24, unit: 'h', milliseconds: 86_400_000 });
  });

  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
  ])('converts %s to milliseconds', (text, milliseconds) => {
    expect(parseDuration(text)?.milliseconds).toBe(milliseconds);
  });

  it('keeps the unit the owner wrote, so a message can echo it back', () => {
    expect(parseDuration('7d')).toMatchObject({ value: 7, unit: 'd' });
  });

  it('refuses a compound form, which the grammar does not have', () => {
    expect(parseDuration('1d12h')).toBeNull();
  });

  it.each([
    ['24', 'no unit, which is how the seconds-or-hours guess starts'],
    ['h', 'a unit with no number'],
    ['0h', 'a zero wait, which is not a wait'],
    ['-1h', 'a negative wait'],
    ['1.5h', 'a fraction, which the grammar does not admit'],
    ['24H', 'an upper-case unit'],
    ['24 h', 'a space the grammar does not allow'],
    [' 24h', 'leading whitespace'],
    ['', 'an empty string'],
    ['24w', 'a unit outside s, m, h, d'],
  ])('refuses %s (%s)', (text) => {
    expect(parseDuration(text)).toBeNull();
  });

  it.each([[null], [undefined], [24], [{ hours: 24 }], [['24h']]])(
    'refuses %s, which is not even text',
    (value) => {
      expect(parseDuration(value)).toBeNull();
    },
  );

  it('states its grammar in one place, with both the good and the bad example', () => {
    expect(DURATION_GRAMMAR).toContain('24h');
    expect(DURATION_GRAMMAR).toContain('1d12h');
  });
});
