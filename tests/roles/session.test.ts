import { describe, expect, it } from 'vitest';
import type { ProjectConfig } from '../../src/config/schema.js';
import { ROLES, type RoleName } from '../../src/roles/schema.js';
import {
  BANNED_PERMISSION_MODES,
  ROLE_PERMISSION_MODE,
  RoleSessionRefusedError,
  buildRoleSession,
} from '../../src/roles/session.js';

/**
 * The role session factory (SDD §4.1, §4.2).
 *
 * PM and Implementer are two configurations of one builder, so what is asserted
 * here is mostly what the two have in COMMON: a difference that appears
 * anywhere outside the three intended axes is a role acquiring a capability
 * nobody granted it.
 */

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: 'internal/docs',
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['npm run test', 'npm run lint'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 3,
  usageBudget: { usd: 20 },
  trackRuntime: false,
};

const root = '/repositories/example';

function sessionFor(role: RoleName) {
  return buildRoleSession({ role, config, root });
}

/** The three axes SDD §4.2 says the roles differ along, as option keys. */
const INTENDED_DIFFERENCES = ['systemPrompt', 'tools', 'allowedTools', 'disallowedTools'];

describe('a session is constructed for each role from the contract', () => {
  it('constructs both roles', () => {
    expect(ROLES.map((role) => sessionFor(role).role)).toEqual(['pm', 'implementer']);
  });

  it('gives every role the repository as its working directory', () => {
    for (const role of ROLES) {
      expect(sessionFor(role).options.cwd).toBe(root);
    }
  });

  it('gives every role a non-empty system prompt', () => {
    for (const role of ROLES) {
      expect(sessionFor(role).options.systemPrompt).toMatch(/\S/);
    }
  });

  it('loads no settings file, so no file outside the contract can widen a role', () => {
    for (const role of ROLES) {
      expect(sessionFor(role).options.settingSources).toEqual([]);
    }
  });
});

describe('the two roles differ only in system prompt, tool surface and permission rules', () => {
  it('carries no difference outside those three axes', () => {
    const pm = sessionFor('pm').options as Record<string, unknown>;
    const implementer = sessionFor('implementer').options as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(pm), ...Object.keys(implementer)])].sort();

    const differing = keys.filter(
      (key) => JSON.stringify(pm[key]) !== JSON.stringify(implementer[key]),
    );

    expect(differing.filter((key) => !INTENDED_DIFFERENCES.includes(key))).toEqual([]);
  });

  it('gives the two roles different allow rules', () => {
    expect(sessionFor('pm').options.allowedTools).not.toEqual(
      sessionFor('implementer').options.allowedTools,
    );
  });

  it('agrees on every option outside those three', () => {
    const pm = sessionFor('pm').options as Record<string, unknown>;
    const implementer = sessionFor('implementer').options as Record<string, unknown>;

    for (const key of Object.keys(pm)) {
      if (INTENDED_DIFFERENCES.includes(key)) continue;
      expect({ key, value: pm[key] }).toEqual({ key, value: implementer[key] });
    }
  });

  it('gives the two roles different system prompts', () => {
    expect(sessionFor('pm').options.systemPrompt).not.toBe(
      sessionFor('implementer').options.systemPrompt,
    );
  });

  it('keeps the shell out of the PM tool surface, which does not read code', () => {
    expect(sessionFor('pm').options.tools).not.toContain('Bash');
    expect(sessionFor('implementer').options.tools).toContain('Bash');
  });

  it('installs the same hook object on both roles, so neither can be intercepted less', () => {
    const hooks = { PreToolUse: [{ hooks: [] }] };
    const pm = buildRoleSession({ role: 'pm', config, root, hooks });
    const implementer = buildRoleSession({ role: 'implementer', config, root, hooks });

    expect(pm.options.hooks).toBe(hooks);
    expect(implementer.options.hooks).toBe(hooks);
  });
});

describe('both roles are constructed in default mode', () => {
  it('sets default without being asked', () => {
    for (const role of ROLES) {
      expect(sessionFor(role).options.permissionMode).toBe(ROLE_PERMISSION_MODE);
    }
    expect(ROLE_PERMISSION_MODE).toBe('default');
  });

  it('accepts default when it is asked for explicitly', () => {
    const session = buildRoleSession({ role: 'pm', config, root, permissionMode: 'default' });

    expect(session.options.permissionMode).toBe('default');
  });

  it.each(BANNED_PERMISSION_MODES)('refuses %s, naming the mode', (mode) => {
    expect(() =>
      buildRoleSession({ role: 'implementer', config, root, permissionMode: mode }),
    ).toThrowError(RoleSessionRefusedError);
    expect(() =>
      buildRoleSession({ role: 'implementer', config, root, permissionMode: mode }),
    ).toThrowError(new RegExp(mode));
  });

  it('bans exactly the three modes D-43 names', () => {
    expect([...BANNED_PERMISSION_MODES].sort()).toEqual(['auto', 'bypassPermissions', 'dontAsk']);
  });

  it('refuses a mode that is neither default nor banned, rather than passing it through', () => {
    // SDD §4.2: both roles run in `default`. acceptEdits and plan are not
    // among D-43's three, and silently honouring them would make the stated
    // mode a suggestion.
    expect(() =>
      buildRoleSession({ role: 'pm', config, root, permissionMode: 'acceptEdits' }),
    ).toThrowError(/acceptEdits/);
    expect(() =>
      buildRoleSession({ role: 'pm', config, root, permissionMode: 'plan' }),
    ).toThrowError(/plan/);
  });

  it('never allows the flag that skips permissions entirely', () => {
    for (const role of ROLES) {
      expect(sessionFor(role).options.allowDangerouslySkipPermissions).toBeUndefined();
    }
  });
});

describe('the rules are anchored against the contract as it is actually written', () => {
  it('reads the same document root whether or not it carries a trailing slash', () => {
    const plain = buildRoleSession({ role: 'pm', config, root });
    const trailing = buildRoleSession({
      role: 'pm',
      config: { ...config, docRoot: 'internal/docs/' },
      root,
    });

    expect(trailing.options.allowedTools).toEqual(plain.options.allowedTools);
  });

  it('anchors every rule at the working directory with a single leading slash', () => {
    for (const role of ROLES) {
      const rules = [
        ...(sessionFor(role).options.allowedTools ?? []),
        ...(sessionFor(role).options.disallowedTools ?? []),
      ];
      const paths = rules
        .map((rule) => /^[A-Za-z]+\((.*)\)$/.exec(rule)?.[1])
        .filter((path): path is string => path?.startsWith('/') === true);

      expect(paths.length).toBeGreaterThan(0);
      for (const path of paths) expect(path).not.toMatch(/\/\//);
    }
  });

  it('names the green definition commands as the Implementer allow rules', () => {
    expect(sessionFor('implementer').options.allowedTools).toEqual([
      'Bash(npm run test)',
      'Bash(npm run lint)',
    ]);
  });
});

describe('a role prompt paraphrases documents, so it names the ones it paraphrases', () => {
  /**
   * The one home rule has a special case for a fact written in a document and
   * restated in code: the restatement is allowed, but it cites the section, and
   * something makes divergence noisy (dev-protocol failure pattern 1).
   *
   * A prompt cannot be pinned to a document mechanically, because it is prose.
   * What can be pinned is the citation, which is what a reader follows when the
   * prose and the document disagree. A prompt rewritten without its citations
   * fails here, which is the noise this rule is entitled to.
   */
  const REQUIRED_CITATIONS: Record<RoleName, readonly string[]> = {
    pm: ['SDD 4.1', 'CHARTER 2.2', 'SDD 3.2', 'FR-3.4'],
    implementer: ['FR-2.1', 'SRS 3.5', 'D-39', 'SDD 4.2', 'FR-7.1', 'TD-4', 'TD-2'],
  };

  it.each(ROLES)('cites every document section the %s prompt leans on', (role) => {
    const prompt = sessionFor(role).options.systemPrompt as string;
    const missing = REQUIRED_CITATIONS[role].filter((citation) => !prompt.includes(citation));

    expect(missing).toEqual([]);
  });

  it('states no permission rule in either prompt', () => {
    // FR-2.1: role permissions are enforced by configuration, not by prompt
    // text. A prompt that also states them gives the rule a second home, and
    // the second home is the one a model can be talked out of.
    for (const role of ROLES) {
      const prompt = (sessionFor(role).options.systemPrompt as string).toLowerCase();
      expect(prompt).not.toContain('you are allowed to');
      expect(prompt).not.toContain('permission mode');
      expect(prompt).not.toContain('allowedtools');
      expect(prompt).not.toContain('disallowedtools');
    }
  });
});
