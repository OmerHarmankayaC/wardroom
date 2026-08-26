import type { ProjectConfig } from '../config/schema.js';
import { readOpenTour } from '../progress/open-tour.js';
import type { ClosingSession } from './closing.js';
import type { ImplementerSession } from './executing.js';
import type { PmSession } from './planning.js';
import {
  acceptancePrompt,
  jobPrompt,
  planningPrompt,
  readAcceptanceAnswer,
  reportPrompt,
  settleDebtPrompt,
  tourLogPrompt,
} from './prompts.js';
import { tourLogPath } from './tour-log.js';
import type { ScopedSession, SessionWiring } from './wiring.js';

/**
 * The drivers' interfaces, over real sessions (SDD §4.1, §4.2, §4.6, D-99).
 *
 * Each driver states what it needs of a session and nothing about where one
 * comes from, which is what let them be exercised without an account. This is
 * the other half: the same three interfaces, backed by an assembled session
 * driven turn by turn.
 *
 * One session per entry into one state, and the shape enforces it: the factory
 * opens, the run loop closes at the exit, and nothing holds a session across
 * two states. A retry after `FAILED` calls `executing` again and gets a second
 * session, which is what D-99 says and what NFR-4's attribution by state needs.
 */

/**
 * A session that answered the acceptance question with neither token.
 *
 * §4.2 fixes the answer's grammar and says that anything else is neither
 * answer and stops the resumption rather than being guessed at (D-103).
 * Reading it as `fail` would redo a job that was done, which is how work is
 * lost; reading it as `pass` would skip one that was not. So the drive stops
 * and the run says what it was given.
 */
export class AcceptanceAnswerUnreadableError extends Error {
  readonly jobIndex: number;

  constructor(jobIndex: number, answer: string | null) {
    super(
      `job ${jobIndex + 1}: the session answered the acceptance question with neither \`pass\` nor \`fail\` on its last line, and the answer is not guessed at (SDD §4.2, D-103). It said: ${answer === null ? 'nothing at all' : JSON.stringify(answer.slice(-200))}`,
    );
    this.name = 'AcceptanceAnswerUnreadableError';
    this.jobIndex = jobIndex;
  }
}

/**
 * The three openers, one per role-bearing state.
 *
 * A factory rather than three ready sessions, because a cycle may enter a
 * state more than once and each entry is its own session.
 */
export interface DriverSessionFactory {
  readonly planning: () => ScopedSession<PmSession>;
  readonly executing: (tourId: string) => ScopedSession<ImplementerSession>;
  readonly closing: (tourId: string) => ScopedSession<ClosingSession>;
}

export interface DriverSessionInput {
  readonly root: string;
  readonly config: ProjectConfig;
  readonly wiring: SessionWiring;
}

/** How many jobs the block currently holds, for the turn that names one of them. */
function jobCount(input: DriverSessionInput): number {
  const read = readOpenTour(input.root, input.config.docRoot);
  return read.kind === 'open' ? read.block.jobs.length : 0;
}

export function createDriverSessions(input: DriverSessionInput): DriverSessionFactory {
  return {
    /**
     * Planning, where one attempt is one session.
     *
     * §3.2 has an unparseable plan re-enter `PLANNING`, so each attempt is an
     * entry and D-99 gives each entry its own session. The drive loops over
     * attempts inside one call, so the session is opened per `plan()` rather
     * than per call to this opener.
     */
    planning: () => ({
      session: {
        plan: async () => {
          const { driven } = input.wiring.openFor('pm', 'PLANNING', null, 'none');
          try {
            await driven.turn(planningPrompt());
          } finally {
            await driven.close();
          }
        },
      },
      close: async () => ({ text: null, errors: [], failed: false }),
    }),

    executing: (tourId) => {
      const { driven, meter } = input.wiring.openFor('implementer', 'EXECUTING', tourId, 'report');
      const session: ImplementerSession = {
        runJob: async (job, index) => {
          await driven.turn(jobPrompt(job, index, jobCount(input)));
          // The boundary line, written where the job ended (NFR-4, D-80,
          // D-84). The orchestrator's own boundary is the marker write in the
          // drive; this is the same moment seen by the meter.
          meter.boundary('EXECUTING', index + 1);
        },
        acceptancePasses: async (job, index) => {
          const answer = await driven.turn(acceptancePrompt(job, index));
          // A turn that failed produced no answer at all, which is the same
          // absence as an unreadable one and gets the same treatment.
          const read = answer.failed ? 'unreadable' : readAcceptanceAnswer(answer.text);
          if (read === 'unreadable') {
            throw new AcceptanceAnswerUnreadableError(index, answer.text);
          }
          return read === 'pass';
        },
      };
      return {
        session,
        // The report is asked for as the last turn, because the consumer
        // writes whatever the last result carried (§4.2, D-73, D-82). Without
        // it the file would hold the answer to the last acceptance question,
        // and closure would read a one-word report as the account of the tour.
        // Asked however the drive ended: a session that stopped at a stop
        // condition owes the same account as one that finished the list.
        close: async () => {
          await driven.turn(reportPrompt());
          return await driven.close();
        },
      };
    },

    closing: (tourId) => {
      const { driven } = input.wiring.openFor('pm', 'CLOSING', tourId, 'none');
      const session: ClosingSession = {
        settleDebt: async (debt) => {
          await driven.turn(settleDebtPrompt(debt));
        },
        writeTourLog: async (log) => {
          await driven.turn(
            tourLogPrompt(log.tourId, tourLogPath(input.root, input.config, log.tourId), log.body),
          );
        },
      };
      return { session, close: () => driven.close() };
    },
  };
}

/**
 * A factory over sessions that already exist, for callers that hold their own.
 *
 * The drives were written against injected interfaces and the tests above this
 * line still are, which is the seam D-85 puts at the SDK rather than at the
 * drivers. This keeps that seam reachable without a second entry point into
 * the run loop: the loop asks the factory at every state entry either way, so
 * what it does about D-99 is the same code in both cases.
 */
export function fixedSessions(sessions: {
  readonly pm: PmSession;
  readonly implementer: ImplementerSession;
  readonly closing: ClosingSession;
}): DriverSessionFactory {
  const scoped = <T>(session: T): ScopedSession<T> => ({
    session,
    close: async () => ({ text: null, errors: [], failed: false }),
  });
  return {
    planning: () => scoped(sessions.pm),
    executing: () => scoped(sessions.implementer),
    closing: () => scoped(sessions.closing),
  };
}
