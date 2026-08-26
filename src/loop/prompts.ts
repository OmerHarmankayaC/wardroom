import type { TourJob } from '../progress/open-tour.js';
import type { InboxLine } from '../state/inbox.js';
import type { ReportedDebt } from '../state/report.js';

/**
 * What the orchestrator says to a session, turn by turn (SDD §4.1, §4.2,
 * §4.6).
 *
 * The role's standing instructions are its system prompt (`roles/definition`);
 * these are the turns. They cite document sections rather than restating them,
 * for the reason the system prompts do: a requirement explained in a prompt is
 * a requirement with two homes, and the copy in the prompt is the one nobody
 * bumps when the document changes.
 *
 * **The acceptance answer's grammar is fixed by SDD §4.2 (D-103) and read
 * here.** §4.4 step 4 resumes at the first job whose acceptance criterion does
 * not pass, so the loop asks a session and reads the answer, and a message a
 * model produces and a parser consumes is a contract in exactly the sense D-94
 * names. The token is written into the question from the same constant the
 * reader compares against, so the asking side and the reading side cannot
 * drift.
 */

/** The token for a criterion that passes (SDD §4.2, D-103). */
export const PASS = 'pass';
/** The token for one that does not. */
export const FAIL = 'fail';

/**
 * What a session answered, in the three answers §4.2 allows.
 *
 * `unreadable` is not a third verdict about the job: it is the absence of one.
 * The document is explicit that anything which is neither token is neither
 * answer, and that resumption stops rather than guessing. Reading it as `fail`
 * would redo a job that was done, and redoing a done job is how work is lost;
 * reading it as `pass` would skip one that was not.
 */
export type AcceptanceAnswer = 'pass' | 'fail' | 'unreadable';

/**
 * Reads the last line of a reply as the answer (SDD §4.2, D-103).
 *
 * The comparison is case-insensitive on the token and nothing else: a reply
 * ending in `Pass` is the same claim as one ending in `pass`, and a reply
 * ending in `pass, mostly` is not a token at all.
 */
export function readAcceptanceAnswer(text: string | null): AcceptanceAnswer {
  if (text === null) return 'unreadable';
  const last = text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop();
  if (last === undefined) return 'unreadable';
  const token = last.toLowerCase();
  if (token === PASS) return 'pass';
  if (token === FAIL) return 'fail';
  return 'unreadable';
}

const ANSWER_RULE = `Answer with your reasoning if you need it, and make the LAST line of your reply exactly \`${PASS}\` or exactly \`${FAIL}\`, one token and nothing else. Anything else is neither answer and stops the resumption rather than being guessed at (SDD 4.2).`;

/** The PM's planning turn (SDD §4.1). */
export function planningPrompt(): string {
  return [
    'Plan the next tour by SDD 4.1, and write the open-tour block into the Open',
    'tour section of PROGRESS in the grammar SRS 3.5 fixes. The block is the',
    'output: what you say here is not read, and the file is.',
    '',
    'Write nothing else in the document root during this turn. If the plan needs',
    'a scope decision, say so and write no block: an unparseable or absent block',
    'spends an attempt, and a scope question reaches the owner as a gate.',
  ].join('\n');
}

/** The Implementer's turn for one job (SDD §4.2). */
export function jobPrompt(job: TourJob, index: number, total: number): string {
  return [
    `Job ${index + 1} of ${total}: ${job.title}`,
    `Acceptance criterion: ${job.criterion}`,
    '',
    'Work it by SDD 4.2: implement, test, run the failure-pattern audit against',
    "this job's diff, check the criterion, update this row's status in the",
    'open-tour block, and commit once at the boundary with that status update in',
    'the same staged set. One job is one commit however many files it touches.',
    '',
    'If the audit raises a finding, append it as a new job row with its own',
    'acceptance criterion and commit it at its own boundary (D-34, D-95). Never',
    'amend and never a fixup commit.',
  ].join('\n');
}

/** The Implementer's turn asking whether one job's criterion holds (SDD §4.4 step 4). */
export function acceptancePrompt(job: TourJob, index: number): string {
  return [
    `Does the acceptance criterion of job ${index + 1} pass, as the repository`,
    'stands right now?',
    '',
    `Job: ${job.title}`,
    `Criterion: ${job.criterion}`,
    '',
    'Check it against the repository rather than against the recorded status: the',
    'criterion is the evidence and the status is a record (D-65). Do not do any',
    'work in this turn.',
    '',
    ANSWER_RULE,
  ].join('\n');
}

/**
 * The Implementer's last turn: the closing report (SDD §4.2, D-82, D-94).
 *
 * Asked rather than assumed. The report is the session's last message, and the
 * consumer writes whatever the last result carried; without this turn that
 * would be the answer to the last acceptance question, and closure would read
 * a one-word file as the account of the tour.
 *
 * The grammar is not restated here. §4.2 fixes it and the role's system prompt
 * cites the section, so a copy in this string would be the copy nobody bumps.
 */
export function reportPrompt(): string {
  return [
    'The job list is finished or has stopped. Write the closing report as your',
    'last message, in the grammar SDD 4.2 fixes: the five named sections in that',
    'order, with an empty one saying none rather than being left out.',
    '',
    'Report what happened rather than what was planned. The commits are checked',
    'against .git at closure and a claim that does not hold is written into the',
    'tour log (SDD 4.6 step 2), so an honest report costs nothing and an',
    'optimistic one is found.',
  ].join('\n');
}

/** The PM's turn settling one document debt (SDD §4.6 step 3). */
export function settleDebtPrompt(debt: ReportedDebt): string {
  return [
    `Settle this document debt in ${debt.document} section ${debt.section}:`,
    '',
    debt.problem,
    '',
    'Write the change into the document, bump its version, and add a change-log',
    'row for that version (FR-6.1). Settle it from the canonical documents where',
    "you can; a change that needs a scope decision is the owner's and reaches",
    'them as a gate instead (D-75).',
  ].join('\n');
}

/** The PM's turn writing the tour log (SDD §4.6 step 4). */
export function tourLogPrompt(tourId: string, path: string, body: string): string {
  return [
    `Write the tour log for ${tourId} to ${path}. This is the permanent record;`,
    'the open-tour block is not, and it is about to be cleared.',
    '',
    'The body below was assembled by the orchestrator from the report and from',
    'the repository. Write it as it stands, then add anything a later reader',
    'needs that it does not carry. Do not remove what it says about where the',
    'report and the repository disagreed (SDD 4.6 step 2).',
    '',
    body,
  ].join('\n');
}

/**
 * The owner's injected context, as it reaches a session's opening prompt
 * (FR-5.2, SDD §5.1, D-108).
 *
 * Quoted rather than paraphrased, and labelled as the owner's words rather
 * than the orchestrator's, because the two are not interchangeable: a role
 * that could not tell them apart would treat a note as an instruction from the
 * system it runs under.
 *
 * It is context and not a decision. The block says so, so that a session
 * cannot read a note about a push as permission to push: a gate is released by
 * the owner answering it and by nothing else (FR-3.1).
 */
export function injectedContext(lines: readonly InboxLine[]): string {
  if (lines.length === 0) return '';
  return [
    'The owner left you context outside a gate (SRS FR-5.2). It is context and',
    'not a decision: it approves nothing and releases no gate, and anything',
    'gate classified still goes to the owner as a gate.',
    '',
    ...lines.map((line) => `- ${line.writtenAt}: ${line.text}`),
    '',
  ].join('\n');
}

/** Puts the owner's context ahead of the turn it opens, or leaves the turn alone. */
export function withInjectedContext(lines: readonly InboxLine[], turn: string): string {
  const context = injectedContext(lines);
  return context === '' ? turn : `${context}\n${turn}`;
}
