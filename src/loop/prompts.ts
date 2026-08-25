import type { TourJob } from '../progress/open-tour.js';
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
 * **The one-word answers are a contract, and this is their single home.** Two
 * of the turns below ask a question the loop has to act on, and a model
 * answering in prose is a model the parser cannot be held to (D-94's lesson,
 * one level down). The token is written into the question and read back by
 * {@link answersYes}, so the asking side and the reading side cannot drift.
 * The design document names no grammar for either, which is reported as a
 * document debt rather than settled here.
 */

/** The affirmative token, in the question and in the parser both. */
export const YES = 'YES';
/** The negative token. Anything that is not the affirmative reads as this. */
export const NO = 'NO';

/**
 * Whether a session's answer was affirmative.
 *
 * Anything that is not the affirmative token is negative, deliberately: for
 * both questions the loop asks, the affirmative is the answer that lets work
 * be skipped or a commit be made, so an unreadable answer must not be it.
 */
export function answersYes(text: string | null): boolean {
  if (text === null) return false;
  const last = text
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .pop();
  return last === YES;
}

const ANSWER_RULE = `Answer with your reasoning if you need it, and make the LAST line of your reply exactly ${YES} or exactly ${NO}. Anything that is not ${YES} is read as ${NO}.`;

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
