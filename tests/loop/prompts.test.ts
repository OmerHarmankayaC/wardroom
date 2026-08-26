import { describe, expect, it } from 'vitest';
import { FAIL, PASS, acceptancePrompt, readAcceptanceAnswer } from '../../src/loop/prompts.js';

/**
 * The acceptance answer's grammar (SDD §4.2, D-103).
 *
 * §4.4 step 4 resumes at the first job whose acceptance criterion does not
 * pass, so the loop asks a session and reads the answer. A message a model
 * produces and a parser consumes is a contract in exactly the sense D-94
 * names, and this is the reading half of it.
 *
 * The replies below are written as a session would write them, prose and all,
 * rather than as the two tokens alone: the rule is about the last line of a
 * reply, and a check fed only bare tokens would never meet one.
 */

const job = { title: 'First job', criterion: 'the first thing holds', status: 'pending' } as const;

describe('the two tokens', () => {
  it('reads a reply whose last line is the passing token', () => {
    expect(readAcceptanceAnswer(`I ran the suite and it is green.\n\n${PASS}`)).toBe('pass');
  });

  it('reads a reply whose last line is the failing token', () => {
    expect(readAcceptanceAnswer(`Two of the three cases still fail.\n${FAIL}`)).toBe('fail');
  });

  it('reads the token whatever case it is written in', () => {
    expect(readAcceptanceAnswer('checked\nPass')).toBe('pass');
    expect(readAcceptanceAnswer('checked\nFAIL')).toBe('fail');
  });

  it('ignores trailing blank lines, which a reply ends with as often as not', () => {
    expect(readAcceptanceAnswer(`checked\n${PASS}\n\n   \n`)).toBe('pass');
  });
});

describe('anything else is neither answer and stops the resumption', () => {
  /**
   * Not a third verdict about the job: the absence of one. Reading it as
   * `fail` would redo a job that was done, which is how work is lost, and
   * reading it as `pass` would skip one that was not.
   */
  for (const [what, reply] of [
    ['prose that says it passed without the token', 'Yes, the criterion holds.'],
    ['the token with something after it', `${PASS}, mostly`],
    ['the token with something before it', `verdict: ${PASS}`],
    ['a token that is neither', 'checked\nmaybe'],
    ['an empty reply', ''],
    ['whitespace', '   \n\n  '],
    ['the token on a line that is not the last', `${PASS}\nbut see the note above`],
  ] as const) {
    it(`refuses ${what}`, () => {
      expect(readAcceptanceAnswer(reply)).toBe('unreadable');
    });
  }

  it('refuses a session that produced no text at all', () => {
    expect(readAcceptanceAnswer(null)).toBe('unreadable');
  });
});

describe('the question names the grammar it will be read by', () => {
  it('carries both tokens, from the constants the reader compares against', () => {
    const asked = acceptancePrompt(job, 0);

    expect(asked).toContain(PASS);
    expect(asked).toContain(FAIL);
  });

  it('says what happens to anything else, rather than leaving it to be found out', () => {
    expect(acceptancePrompt(job, 0)).toMatch(/stops the resumption/);
  });

  it('names the job and its criterion, since that is what is being asked about', () => {
    const asked = acceptancePrompt(job, 2);

    expect(asked).toContain('job 3');
    expect(asked).toContain(job.criterion);
  });

  it('tells the session to check the repository rather than the recorded status', () => {
    // D-65: the criterion is the evidence and the status is a record. A
    // session that read the row back would be answering from the thing §4.4
    // step 4 exists to not trust.
    expect(acceptancePrompt(job, 0)).toMatch(/rather than against the recorded status/);
  });
});
