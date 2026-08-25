import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  ModelUsage,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultError,
  SDKResultMessage,
  SDKResultSuccess,
  SDKSessionStateChangedMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/load.js';

/**
 * The SDK message contract the assembly reads (SDD Appendix A.4, D-86 to
 * D-89).
 *
 * Every field the orchestrator's adapter reads off the message stream is
 * asserted here at the type level, so an upgrade that renames or moves one
 * fails `tsc` rather than the run. The distinction is the whole point: these
 * fields are read out of a 39 member union whose members are structurally
 * similar, so a moved field does not throw. It yields `undefined`, and an
 * `undefined` token count sums to a total that is quietly too small.
 *
 * The assertions are types rather than runtime checks because there is nothing
 * to run: no fixture proves a field exists on a declared type, only that the
 * fixture the test wrote has it. Type declarations are what the compiler reads
 * and what an upgrade changes.
 *
 * A.2 and A.3 were both wrong as first recorded, and each would have shipped a
 * silent failure into the mechanism protecting push. This file is the standing
 * form of that lesson for A.4.
 */

/** Compiles only for `true`. The whole mechanism of this file. */
type Assert<T extends true> = T;
type Not<T extends boolean> = T extends true ? false : true;
/** True when `K` is a declared key of `T`. */
type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;
/** True when every member of `A` is assignable to `B`. */
type Assignable<A, B> = [A] extends [B] ? true : false;

/*
 * The mechanism first, in both directions.
 *
 * Without these, a helper that answered `true` for everything would make every
 * assertion below pass while checking nothing, which is the silent pass this
 * project treats as the worst failure mode of any check. A type-level check
 * cannot report at runtime that it went vacuous, so it is pinned here against
 * a shape whose answer is known.
 */
type _KeyThatIsPresent = Assert<HasKey<{ present: number }, 'present'>>;
type _KeyThatIsAbsent = Assert<Not<HasKey<{ present: number }, 'absent'>>>;
type _AssignableHolds = Assert<Assignable<'a', string>>;
type _AssignableFails = Assert<Not<Assignable<string, 'a'>>>;

/*
 * A session ends when the generator completes, and nothing else marks it
 * (A.4). The run cycle and the report capture both rest on this: a driver
 * that treated a result message as the session's end would stop reading at
 * the first turn.
 */
type _SessionIsAnAsyncGenerator = Assert<Assignable<Query, AsyncGenerator<SDKMessage, void>>>;

/*
 * `type` alone does not discriminate the union: 28 of the 39 members carry
 * `type: 'system'` and separate on `subtype`. Asserted as the plural fact it
 * is, rather than as a member count that an upgrade would break without
 * anything being wrong: what the adapter may not do is assume that narrowing
 * on `type` leaves one member.
 */
type SystemMessages = Extract<SDKMessage, { type: 'system' }>;
type _SystemIsNotOneMember = Assert<Not<Assignable<SystemMessages, SDKSessionStateChangedMessage>>>;
type _SystemSeparatesOnSubtype = Assert<Assignable<SDKSessionStateChangedMessage, SystemMessages>>;
type _TheTurnOverSignalCarriesItsState = Assert<
  Assignable<SDKSessionStateChangedMessage['state'], 'idle' | 'running' | 'requires_action'>
>;

/*
 * Per-message usage (D-84, D-87). `message.id` is read to deduplicate: one
 * API turn may emit several assistant messages sharing an id, and summing
 * their usage counts that turn more than once.
 */
type AssistantBody = SDKAssistantMessage['message'];
type _AssistantIsTagged = Assert<Assignable<SDKAssistantMessage['type'], 'assistant'>>;
type _AssistantCarriesAnId = Assert<Assignable<AssistantBody['id'], string>>;
type _AssistantCarriesUsage = Assert<HasKey<AssistantBody, 'usage'>>;
type _PerMessageInput = Assert<Assignable<AssistantBody['usage']['input_tokens'], number>>;
type _PerMessageOutput = Assert<Assignable<AssistantBody['usage']['output_tokens'], number>>;
type _PerMessageCacheRead = Assert<HasKey<AssistantBody['usage'], 'cache_read_input_tokens'>>;
type _PerMessageCacheWrite = Assert<HasKey<AssistantBody['usage'], 'cache_creation_input_tokens'>>;

/*
 * The cache fields are nullable per message and not nullable on a result,
 * which is an asymmetry the accumulator has to carry rather than discover.
 * Asserted so that an upgrade making them agree shows up here as a decision to
 * take, not as a null that reaches arithmetic.
 */
type _PerMessageCacheReadIsNullable = Assert<
  Assignable<null, AssistantBody['usage']['cache_read_input_tokens']>
>;
type _ResultCacheReadIsNotNullable = Assert<
  Not<Assignable<null, SDKResultSuccess['usage']['cache_read_input_tokens']>>
>;

/*
 * The session total (D-86): `modelUsage` on the last result, not `usage`.
 * Both are read, because the gap between them is the auxiliary usage that
 * gets recorded as auxiliary rather than as drift, so losing either one loses
 * the reconciliation.
 */
type _SessionTotalIsPerModel = Assert<
  Assignable<SDKResultSuccess['modelUsage'], Record<string, ModelUsage>>
>;
type _MainLoopFigureIsAlsoRead = Assert<HasKey<SDKResultSuccess, 'usage'>>;
type _ModelUsageInput = Assert<Assignable<ModelUsage['inputTokens'], number>>;
type _ModelUsageOutput = Assert<Assignable<ModelUsage['outputTokens'], number>>;
type _ModelUsageCacheRead = Assert<Assignable<ModelUsage['cacheReadInputTokens'], number>>;
type _ModelUsageCacheWrite = Assert<Assignable<ModelUsage['cacheCreationInputTokens'], number>>;
type _ModelUsageCost = Assert<Assignable<ModelUsage['costUSD'], number>>;
type _CumulativeCostIsRead = Assert<Assignable<SDKResultSuccess['total_cost_usd'], number>>;

/*
 * Both result members carry the totals, so a session that ends on an error
 * still meters (D-88). A total read only off the success member would report
 * nothing spent for exactly the run that failed expensively.
 */
type _ErrorResultAlsoMeters = Assert<
  Assignable<SDKResultError['modelUsage'], Record<string, ModelUsage>>
>;

/*
 * The report artifact (D-73, D-82, D-88). The report text lives on the
 * success member; the error member has no such field, only its errors. The
 * negative assertion is the load-bearing one: D-88 exists because that field
 * is absent, so a version that added it would turn an aborted record into a
 * report and this file is where that has to be noticed.
 */
type _ResultIsTagged = Assert<Assignable<SDKResultSuccess['type'], 'result'>>;
type _SuccessIsItsSubtype = Assert<Assignable<SDKResultSuccess['subtype'], 'success'>>;
type _ReportTextIsAString = Assert<Assignable<SDKResultSuccess['result'], string>>;
type _ErrorCarriesNoReport = Assert<Not<HasKey<SDKResultError, 'result'>>>;
type _ErrorCarriesItsErrors = Assert<Assignable<SDKResultError['errors'], string[]>>;
type _ErrorSubtypeIsNotSuccess = Assert<Not<Assignable<SDKResultError['subtype'], 'success'>>>;

/*
 * The result union is exactly the two members the branch above splits on, so
 * a third member added by an upgrade fails here rather than falling into
 * whichever branch is written as the default.
 */
type _ResultIsTheTwoKnownMembers = Assert<
  Assignable<SDKResultMessage, SDKResultSuccess | SDKResultError>
>;

/** Keeps every assertion referenced, so none is dropped as dead code. */
type SdkContractAssertions = [
  _KeyThatIsPresent,
  _KeyThatIsAbsent,
  _AssignableHolds,
  _AssignableFails,
  _SessionIsAnAsyncGenerator,
  _SystemIsNotOneMember,
  _SystemSeparatesOnSubtype,
  _TheTurnOverSignalCarriesItsState,
  _AssistantIsTagged,
  _AssistantCarriesAnId,
  _AssistantCarriesUsage,
  _PerMessageInput,
  _PerMessageOutput,
  _PerMessageCacheRead,
  _PerMessageCacheWrite,
  _PerMessageCacheReadIsNullable,
  _ResultCacheReadIsNotNullable,
  _SessionTotalIsPerModel,
  _MainLoopFigureIsAlsoRead,
  _ModelUsageInput,
  _ModelUsageOutput,
  _ModelUsageCacheRead,
  _ModelUsageCacheWrite,
  _ModelUsageCost,
  _CumulativeCostIsRead,
  _ErrorResultAlsoMeters,
  _ResultIsTagged,
  _SuccessIsItsSubtype,
  _ReportTextIsAString,
  _ErrorCarriesNoReport,
  _ErrorCarriesItsErrors,
  _ErrorSubtypeIsNotSuccess,
  _ResultIsTheTwoKnownMembers,
];
type _EveryAssertionIsReferenced = Assert<Assignable<SdkContractAssertions[number], true>>;

/**
 * The version Appendix A was verified against (SDD §2). A change in it is a
 * reason to re-verify the appendix, not a routine upgrade, and the appendix
 * says so in writing. The type assertions above catch a field that moved;
 * this catches a version that moved without one, which is the case where the
 * appendix goes stale silently.
 */
const VERIFIED_AGAINST = '0.3.238';

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/**
 * The installed version, read off the package on disk rather than resolved
 * through the module loader: the package does not expose `./package.json` in
 * its `exports`, so `require` of it throws. Read as the file it is, which is
 * also what `npm ci` writes and what the type assertions above were checked
 * against.
 */
/**
 * The manifest's requirement for the SDK, as written (D-91).
 *
 * The lockfile pins for `npm ci` and not for `npm install`, so a range in the
 * manifest let a contributor drift onto a version Appendix A was never
 * verified against while every document said the version was pinned. A caret
 * is that rule's opposite expressed in the one file a package manager reads.
 */
function manifestSdkRange(): string {
  const manifestPath = resolve(REPO_ROOT, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const range = manifest.dependencies?.['@anthropic-ai/claude-agent-sdk'];
  if (typeof range !== 'string') {
    throw new Error(`no @anthropic-ai/claude-agent-sdk dependency in ${manifestPath}`);
  }
  return range;
}

function installedSdkVersion(): string {
  const manifestPath = resolve(
    REPO_ROOT,
    'node_modules/@anthropic-ai/claude-agent-sdk/package.json',
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') {
    throw new Error(`no version string in ${manifestPath}`);
  }
  return manifest.version;
}

describe('the SDK message contract the assembly reads', () => {
  it('runs against the version Appendix A was verified against', () => {
    expect(installedSdkVersion()).toBe(VERIFIED_AGAINST);
  });

  it('is pinned exactly in the manifest, not by a range the lockfile happens to satisfy', () => {
    // Asserted as an exact equality rather than by testing for the absence of
    // a caret: `>=0.3.238`, `0.3.x` and `latest` are all ranges too, and a
    // check that only knew about `^` would pass on every one of them (D-91).
    expect(manifestSdkRange()).toBe(VERIFIED_AGAINST);
  });

  it('is reached by the green definition, which is what checks its assertions', () => {
    // The suite passing is not evidence that the assertions above hold: they
    // are checked by `tsc` and by nothing else. So the load-bearing question
    // is not whether this file runs, it is whether green still runs a type
    // check at all. Dropped from `verify`, every assertion in this file would
    // go unchecked while the suite stayed green, which is the silent pass the
    // file exists to prevent, one level up.
    const { verify } = loadConfig(REPO_ROOT);

    expect(verify.some((command) => command.includes('typecheck'))).toBe(true);
  });
});
