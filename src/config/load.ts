import { readFileSync } from 'node:fs';
import { isJsonObject } from '../json/guards.js';
import { DURATION_GRAMMAR, type Duration, parseDuration } from './duration.js';
import { wardroomPaths } from './paths.js';
import {
  AUTH_MODES,
  type AuthMode,
  PROJECT_LEVELS,
  type ProjectConfig,
  type ProjectLevel,
} from './schema.js';

/**
 * A project contract that could not be read or does not hold. Every instance
 * carries the reasons, because FR-1.5 requires a *stated* reason: a
 * configuration problem reported as a bare failure is the same operational
 * dead end as a silent default.
 */
export class ConfigError extends Error {
  readonly configFile: string;
  readonly problems: readonly string[];

  constructor(configFile: string, problems: readonly string[]) {
    super(`${configFile} is not a usable project contract:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.configFile = configFile;
    this.problems = problems;
  }
}

function checkString(raw: Record<string, unknown>, key: string, problems: string[]): void {
  const value = raw[key];
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${key}: must be a non-empty string, got ${describe(value)}.`);
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  return JSON.stringify(value) ?? String(value);
}

/**
 * The green definition, checked before anything else it depends on.
 * FR-1.5: missing and empty are failures with reasons, never defaults.
 */
function checkVerify(raw: Record<string, unknown>, problems: string[]): void {
  const verify = raw.verify;
  if (verify === undefined) {
    problems.push(
      'verify: missing. A project without a green definition has none to infer (SRS §3.4, FR-1.5).',
    );
    return;
  }
  if (!Array.isArray(verify)) {
    problems.push(`verify: must be an ordered list of commands, got ${describe(verify)}.`);
    return;
  }
  if (verify.length === 0) {
    problems.push(
      'verify: empty. An empty green definition is a verification failure, never a pass (FR-1.5).',
    );
    return;
  }
  verify.forEach((command, index) => {
    if (typeof command !== 'string' || command.trim() === '') {
      problems.push(`verify[${index}]: must be a non-empty command, got ${describe(command)}.`);
    }
  });
}

function checkStack(raw: Record<string, unknown>, problems: string[]): void {
  const stack = raw.stack;
  if (!isJsonObject(stack)) {
    problems.push('stack: must be an object with language, runtime and package_manager.');
    return;
  }
  for (const key of ['language', 'runtime', 'package_manager']) {
    if (typeof stack[key] !== 'string' || (stack[key] as string).trim() === '') {
      problems.push(`stack.${key}: must be a non-empty string, got ${describe(stack[key])}.`);
    }
  }
}

function checkUsageBudget(raw: Record<string, unknown>, problems: string[]): void {
  const budget = raw.usage_budget;
  if (!isJsonObject(budget) || typeof budget.usd !== 'number' || !(budget.usd > 0)) {
    problems.push('usage_budget: must be an object with a positive `usd` ceiling (NFR-4).');
  }
}

function validate(raw: unknown, problems: string[]): void {
  if (!isJsonObject(raw)) {
    problems.push(`the contract must be a JSON object, got ${describe(raw)}.`);
    return;
  }

  checkVerify(raw, problems);
  checkString(raw, 'name', problems);
  checkString(raw, 'doc_root', problems);
  checkString(raw, 'default_branch', problems);

  if (!PROJECT_LEVELS.includes(raw.level as ProjectLevel)) {
    problems.push(`level: must be one of ${PROJECT_LEVELS.join(', ')} (SRS §3.2).`);
  }
  if (!AUTH_MODES.includes(raw.auth_mode as AuthMode)) {
    problems.push(`auth_mode: must be one of ${AUTH_MODES.join(', ')} (SDD Appendix A.3).`);
  }
  if (parseDuration(raw.gate_wait) === null) {
    problems.push(
      `gate_wait: must be ${DURATION_GRAMMAR}. Got ${describe(raw.gate_wait)} (FR-3.3, BACKLOG D-22).`,
    );
  }
  if (!Number.isInteger(raw.attempt_budget) || (raw.attempt_budget as number) < 1) {
    problems.push('attempt_budget: must be a positive whole number of attempts (FR-1.3).');
  }
  if (typeof raw.track_runtime !== 'boolean') {
    problems.push('track_runtime: must be true or false, never a string (SRS §3.7).');
  }

  checkStack(raw, problems);
  checkUsageBudget(raw, problems);
}

/** Narrows a contract already proven valid by {@link validate}. */
function build(raw: Record<string, unknown>): ProjectConfig {
  const stack = raw.stack as Record<string, string>;
  const usageBudget = raw.usage_budget as { usd: number };
  return {
    name: raw.name as string,
    level: raw.level as ProjectLevel,
    docRoot: raw.doc_root as string,
    defaultBranch: raw.default_branch as string,
    stack: {
      language: stack.language as string,
      runtime: stack.runtime as string,
      packageManager: stack.package_manager as string,
    },
    verify: Object.freeze([...(raw.verify as string[])]),
    authMode: raw.auth_mode as AuthMode,
    gateWait: parseDuration(raw.gate_wait) as Duration,
    attemptBudget: raw.attempt_budget as number,
    usageBudget: { usd: usageBudget.usd },
    trackRuntime: raw.track_runtime as boolean,
  };
}

/**
 * Reads and validates `<root>/.wardroom/config.json`.
 *
 * Throws {@link ConfigError} listing every problem found. It never repairs,
 * defaults or infers: the one failure this system exists to prevent is a run
 * that reports green for a verification that never happened (FR-1.5, D-13).
 */
export function loadConfig(root: string): ProjectConfig {
  const { configFile } = wardroomPaths(root);

  let text: string;
  try {
    text = readFileSync(configFile, 'utf8');
  } catch {
    throw new ConfigError(configFile, [
      'not found. A managed project states its own contract; Wardroom does not supply one.',
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(configFile, [
      `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }

  const problems: string[] = [];
  validate(raw, problems);
  if (problems.length > 0) throw new ConfigError(configFile, problems);

  return build(raw as Record<string, unknown>);
}
