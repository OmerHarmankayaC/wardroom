import { describe, expect, it } from 'vitest';
import { WIP_SUBJECT_PREFIX } from '../../src/commit/gate.js';
import { deriveCommitOccasion } from '../../src/commit/occasion.js';
import { commitSubject } from '../../src/gates/classify.js';
import type { StateMarker, TourState } from '../../src/state/marker.js';

/**
 * The occasion is derived from the marker, not passed in (SDD §4.5, D-105).
 *
 * The mechanical half of D-105: the occasion was an optional value fixed when
 * the session was built and no caller filled it, so every commit a live
 * session made was denied for want of an occasion nobody supplied. A value
 * fixed at construction could not have been right anyway, since one
 * Implementer session spans many boundaries (D-99).
 *
 * The input here is the marker, which the state machine writes and this module
 * only reads (D-47), so nothing below rests on a record its own subject
 * produced (D-55).
 */

const EXECUTING: StateMarker = {
  state: 'EXECUTING',
  tourId: 'tour-4',
  jobIndex: 2,
  interruptedState: null,
  attemptCount: 0,
  gateId: null,
  disposition: null,
  headCommit: null,
  updatedAt: '2026-08-21T08:00:00.000Z',
};

const CLOSING: StateMarker = {
  ...EXECUTING,
  state: 'CLOSING',
  jobIndex: null,
  disposition: 'closed',
};

describe('the two occasions the marker answers', () => {
  it('reads EXECUTING with a job index as a job boundary', () => {
    const derived = deriveCommitOccasion(EXECUTING, 'feat: job 2');

    expect(derived).toEqual({
      kind: 'derived',
      occasion: { kind: 'job-boundary', tourId: 'tour-4', jobIndex: 2 },
    });
  });

  it('carries the job index of the moment, not one fixed earlier (D-99)', () => {
    const first = deriveCommitOccasion({ ...EXECUTING, jobIndex: 0 }, 'feat: job 1');
    const later = deriveCommitOccasion({ ...EXECUTING, jobIndex: 7 }, 'feat: job 8');

    expect(first.kind === 'derived' && first.occasion).toEqual({
      kind: 'job-boundary',
      tourId: 'tour-4',
      jobIndex: 0,
    });
    expect(later.kind === 'derived' && later.occasion).toEqual({
      kind: 'job-boundary',
      tourId: 'tour-4',
      jobIndex: 7,
    });
  });

  it('reads CLOSING as the closure occasion, with the disposition the marker carries', () => {
    const derived = deriveCommitOccasion({ ...CLOSING, disposition: 'carried' }, 'docs: close');

    expect(derived).toEqual({
      kind: 'derived',
      occasion: {
        kind: 'closure',
        tourId: 'tour-4',
        disposition: 'carried',
      },
    });
  });

  it('gives a job boundary nothing to claim its acceptance or its greenness with', () => {
    // D-105's design half. A criterion is prose and no mechanism can observe
    // one, so a flag for it would be a condition that can never fail, which
    // reads as a check and is not one. Greenness is observed instead (D-58).
    const derived = deriveCommitOccasion(EXECUTING, 'feat: job 2');

    expect(derived.kind === 'derived' && Object.keys(derived.occasion).sort()).toEqual([
      'jobIndex',
      'kind',
      'tourId',
    ]);
  });
});

describe('the occasion the marker cannot answer', () => {
  it('reads the reserved subject as the WIP stop', () => {
    const derived = deriveCommitOccasion(EXECUTING, `${WIP_SUBJECT_PREFIX} context running low`);

    expect(derived).toEqual({
      kind: 'derived',
      occasion: { kind: 'wip-stop', reason: 'context running low' },
    });
  });

  it('reaches the stop from EXECUTING, which also derives the boundary', () => {
    // A stop condition is a decision taken inside EXECUTING and no marker
    // field moves when it is: a tour stopping with unfinished work and a tour
    // at a job boundary read identically. Asking the marker first would make
    // this occasion unreachable, so the subject is read first.
    const boundary = deriveCommitOccasion(EXECUTING, 'feat: job 2');
    const stop = deriveCommitOccasion(EXECUTING, `${WIP_SUBJECT_PREFIX} stopping`);

    expect(boundary.kind === 'derived' && boundary.occasion.kind).toBe('job-boundary');
    expect(stop.kind === 'derived' && stop.occasion.kind).toBe('wip-stop');
  });

  it('reaches it from CLOSING too, since a stop is not about which state asked', () => {
    const derived = deriveCommitOccasion(CLOSING, `${WIP_SUBJECT_PREFIX} stopping`);

    expect(derived.kind === 'derived' && derived.occasion.kind).toBe('wip-stop');
  });

  it('does not read a subject that merely mentions the word', () => {
    const derived = deriveCommitOccasion(EXECUTING, 'feat: finish the WIP: handling');

    expect(derived.kind === 'derived' && derived.occasion.kind).toBe('job-boundary');
  });

  it('answers nothing about whether the stop may proceed', () => {
    // Recognising which occasion is asked for is not judging whether it holds.
    // The branch, the single WIP rule and the staged set are read from the
    // repository by the gate, and this says only which question to ask.
    const derived = deriveCommitOccasion(EXECUTING, `${WIP_SUBJECT_PREFIX} stopping`);

    expect(derived.kind === 'derived' && Object.keys(derived.occasion).sort()).toEqual([
      'kind',
      'reason',
    ]);
  });
});

describe('a marker that names no occasion is undecidable, not an occasion to refuse', () => {
  it.each<TourState>(['IDLE', 'PLANNING', 'VERIFYING', 'GATED', 'PARKED', 'FAILED'])(
    'refuses a commit in %s',
    (state) => {
      const marker: StateMarker =
        state === 'GATED' || state === 'PARKED'
          ? { ...EXECUTING, state, interruptedState: 'EXECUTING', gateId: 'g-1' }
          : { ...EXECUTING, state };

      const derived = deriveCommitOccasion(marker, 'chore: checkpoint');

      expect(derived.kind).toBe('undecidable');
      expect(derived.kind === 'undecidable' && derived.reason).toContain(state);
    },
  );

  it('names all three occasions in the refusal, so a session learns the rule', () => {
    const derived = deriveCommitOccasion({ ...EXECUTING, state: 'IDLE' }, 'chore: x');

    const reason = derived.kind === 'undecidable' ? derived.reason : '';
    expect(reason).toContain('EXECUTING');
    expect(reason).toContain('CLOSING');
    expect(reason).toContain(WIP_SUBJECT_PREFIX);
    expect(reason).toContain('FR-7.1');
  });

  it('refuses EXECUTING with no job index rather than inventing one', () => {
    const derived = deriveCommitOccasion({ ...EXECUTING, jobIndex: null }, 'feat: something');

    expect(derived.kind).toBe('undecidable');
    expect(derived.kind === 'undecidable' && derived.reason).toContain('no job index');
  });

  it('refuses a boundary with no tour, since a job belongs to one', () => {
    const derived = deriveCommitOccasion({ ...EXECUTING, tourId: null }, 'feat: something');

    expect(derived.kind).toBe('undecidable');
  });

  it('refuses CLOSING with no disposition rather than deriving one (D-101)', () => {
    const derived = deriveCommitOccasion({ ...CLOSING, disposition: null }, 'docs: close');

    expect(derived.kind).toBe('undecidable');
    expect(derived.kind === 'undecidable' && derived.reason).toContain('disposition');
  });

  it('refuses CLOSING with no tour', () => {
    const derived = deriveCommitOccasion({ ...CLOSING, tourId: null }, 'docs: close');

    expect(derived.kind).toBe('undecidable');
  });

  it('refuses a commit with no subject at all from a state that names none', () => {
    const derived = deriveCommitOccasion({ ...EXECUTING, state: 'VERIFYING' }, null);

    expect(derived.kind).toBe('undecidable');
  });
});

describe('the subject a commit call asks for', () => {
  it.each([
    ['git commit -m "WIP: stopping"', 'WIP: stopping'],
    ["git commit -m 'WIP: stopping'", 'WIP: stopping'],
    ['git commit --message="WIP: stopping"', 'WIP: stopping'],
    ['git commit -qm "feat: one"', 'feat: one'],
    ['git commit -m feat', 'feat'],
    ['cd sub && git commit -m "feat: one"', 'feat: one'],
    ['git -c user.name=x commit -m "feat: one"', 'feat: one'],
  ])('reads %s', (command, subject) => {
    expect(commitSubject('Bash', { command })).toBe(subject);
  });

  it.each(['git commit --amend --no-edit', 'git commit', 'npm run test', 'git commit-tree abc'])(
    'answers nothing for %s',
    (command) => {
      expect(commitSubject('Bash', { command })).toBeNull();
    },
  );

  it('answers nothing through a tool that is not the shell', () => {
    expect(commitSubject('Read', { file_path: 'git commit -m "WIP: x"' })).toBeNull();
  });

  it('does not read the message of a command that is not the commit', () => {
    // The staging command carries a `-m` of its own in this shape, and reading
    // the wrong segment would let any call name the occasion.
    expect(
      commitSubject('Bash', { command: 'echo -m "WIP: not this" && git commit -m "feat: one"' }),
    ).toBe('feat: one');
  });
});
