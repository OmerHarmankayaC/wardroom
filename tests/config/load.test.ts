import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/load.js';

/**
 * The project contract (SRS §3.1) and, at its centre, the green definition
 * (SRS §3.4). FR-1.5 makes one failure mode illegal at the requirement level:
 * a missing or empty `verify` list must never be defaulted, inferred, or
 * treated as green. These tests are that requirement.
 */

const validConfig = {
  name: 'example',
  level: 'full',
  doc_root: 'docs',
  stack: { language: 'TypeScript', runtime: 'node>=18', package_manager: 'npm' },
  verify: ['npm test', 'npm run lint'],
  auth_mode: 'api_key',
  gate_wait: '24h',
  attempt_budget: 3,
  usage_budget: { usd: 20 },
  track_runtime: true,
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-config-'));
  mkdirSync(join(root, '.wardroom'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(contents: unknown): void {
  const body = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
  writeFileSync(join(root, '.wardroom', 'config.json'), body);
}

/** Runs loadConfig and returns the ConfigError it must have thrown. */
function loadFailure(): ConfigError {
  try {
    loadConfig(root);
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('loadConfig resolved where it was required to reject');
}

describe('loadConfig', () => {
  it('returns the project contract as typed data', () => {
    writeConfig(validConfig);

    const config = loadConfig(root);

    expect(config.name).toBe('example');
    expect(config.level).toBe('full');
    expect(config.docRoot).toBe('docs');
    expect(config.verify).toEqual(['npm test', 'npm run lint']);
    expect(config.authMode).toBe('api_key');
    expect(config.trackRuntime).toBe(true);
    expect(config.attemptBudget).toBe(3);
  });

  it("reads this repository's own contract", () => {
    const config = loadConfig(resolve(import.meta.dirname, '../..'));

    expect(config.name).toBe('wardroom');
    expect(config.docRoot).toBe('internal/docs');
    expect(config.trackRuntime).toBe(false);
    expect(config.verify.length).toBeGreaterThan(0);
  });
});

describe('the green definition (FR-1.5)', () => {
  it('rejects a missing verify list with a stated reason', () => {
    const { verify: _omitted, ...withoutVerify } = validConfig;
    writeConfig(withoutVerify);

    const error = loadFailure();

    expect(error.problems).toContain(
      'verify: missing. A project without a green definition has none to infer (SRS §3.4, FR-1.5).',
    );
  });

  it('rejects an empty verify list with a stated reason', () => {
    writeConfig({ ...validConfig, verify: [] });

    const error = loadFailure();

    expect(error.problems).toContain(
      'verify: empty. An empty green definition is a verification failure, never a pass (FR-1.5).',
    );
  });

  it('never substitutes a default for a missing verify list', () => {
    const { verify: _omitted, ...withoutVerify } = validConfig;
    writeConfig(withoutVerify);

    expect(() => loadConfig(root)).toThrow(ConfigError);
  });

  it('rejects a verify list holding anything but non-empty commands', () => {
    writeConfig({ ...validConfig, verify: ['npm test', '   '] });

    const error = loadFailure();

    expect(error.problems.some((p) => p.startsWith('verify[1]:'))).toBe(true);
  });

  it('names the configuration file in every failure', () => {
    writeConfig({ ...validConfig, verify: [] });

    const error = loadFailure();

    expect(error.configFile).toBe(join(root, '.wardroom', 'config.json'));
    expect(error.message).toContain(error.configFile);
  });
});

describe('contract validation', () => {
  it('reports an absent configuration file rather than assuming defaults', () => {
    const error = loadFailure();

    expect(error.problems).toEqual([expect.stringContaining('not found')]);
  });

  it('reports unparseable JSON as such', () => {
    writeConfig('{ "name": "example",');

    const error = loadFailure();

    expect(error.problems).toEqual([expect.stringContaining('not valid JSON')]);
  });

  it('rejects a level outside the document-set table (SRS §3.2)', () => {
    writeConfig({ ...validConfig, level: 'enormous' });

    const error = loadFailure();

    expect(error.problems.some((p) => p.startsWith('level:'))).toBe(true);
  });

  it('rejects an auth_mode outside the two supported paths (SDD Appendix A.3)', () => {
    writeConfig({ ...validConfig, auth_mode: 'oauth' });

    const error = loadFailure();

    expect(error.problems.some((p) => p.startsWith('auth_mode:'))).toBe(true);
  });

  it('reports every problem at once rather than the first', () => {
    writeConfig({ ...validConfig, verify: [], level: 'enormous', attempt_budget: -1 });

    const error = loadFailure();

    expect(error.problems.length).toBe(3);
  });

  it('accepts a subscription auth mode', () => {
    writeConfig({ ...validConfig, auth_mode: 'subscription' });

    expect(loadConfig(root).authMode).toBe('subscription');
  });

  it('rejects a track_runtime that is not a boolean rather than coercing it', () => {
    writeConfig({ ...validConfig, track_runtime: 'false' });

    const error = loadFailure();

    expect(error.problems.some((p) => p.startsWith('track_runtime:'))).toBe(true);
  });
});
