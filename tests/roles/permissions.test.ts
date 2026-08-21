import { describe, expect, it } from 'vitest';
import type { ProjectConfig, ProjectLevel } from '../../src/config/schema.js';
import { tourLogDirectory, versionCarryingDocuments } from '../../src/documents/set.js';
import { GATE_REACHING_TOOLS, gateClassesReachableBy } from '../../src/gates/classify.js';
import {
  PermissionRuleRefusedError,
  checkAllowRules,
  documentDenyRules,
  rolePermissions,
} from '../../src/roles/permissions.js';
import { ROLES } from '../../src/roles/schema.js';

/**
 * The permission rules derived from the project contract (SDD §4.2, D-44).
 *
 * Two rules are being tested and they fail in opposite directions. The denial
 * fails silently: a rule written in the wrong form denies nothing and reads as
 * though it denied everything. The allow list fails loudly only if something
 * checks it, which is what these tests are.
 */

function configAt(level: ProjectLevel, docRoot = 'internal/docs'): ProjectConfig {
  return {
    name: 'example',
    level,
    docRoot,
    defaultBranch: 'main',
    stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
    verify: ['npm run test'],
    authMode: 'api_key',
    gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
    attemptBudget: 3,
    usageBudget: { usd: 20 },
    trackRuntime: false,
  };
}

/**
 * The form every generated document rule must take, as an assertion rather than
 * as a description, so it can be run against a deliberate mutant and shown to
 * discriminate (SDD Appendix A.2).
 */
function expectDenialForm(rules: readonly string[]): void {
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules) {
    const parsed = /^([A-Za-z]+)\((.+)\)$/.exec(rule);
    expect({ rule, parsed: parsed !== null }).toEqual({ rule, parsed: true });
    expect({ rule, tool: parsed?.[1] }).toEqual({ rule, tool: 'Edit' });
    expect({ rule, anchored: parsed?.[2]?.startsWith('/') }).toEqual({ rule, anchored: true });
  }
}

describe('the document root is denied by enumeration', () => {
  const rules = documentDenyRules(configAt('full'));

  it('denies every version-carrying document of the level', () => {
    for (const name of versionCarryingDocuments('full')) {
      expect(rules).toContain(`Edit(/internal/docs/${name})`);
    }
  });

  it('denies the tour-log directory', () => {
    expect(rules).toContain(`Edit(/internal/docs/${tourLogDirectory()}/**)`);
  });

  it('does not deny PROGRESS, which the Implementer must update at every boundary', () => {
    // The PROGRESS exception is not an exception in the configuration: PROGRESS
    // is simply not in the enumerated set (SDD §4.2, D-39). Denying the root
    // whole would forbid the per job update SRS §3.5 requires.
    expect(rules.join('\n')).not.toContain('PROGRESS');
  });

  it('enumerates and nothing more, because deny cannot be carved out by allow', () => {
    expect(rules).toEqual([
      ...versionCarryingDocuments('full').map((name) => `Edit(/internal/docs/${name})`),
      `Edit(/internal/docs/${tourLogDirectory()}/**)`,
    ]);
  });
});

describe('changing the level changes the rule set through the baseline derivation', () => {
  it.each(['light', 'standard', 'full'] as const)(
    'derives the %s rule set from versionCarryingDocuments, as the baseline does',
    (level) => {
      const documentRules = documentDenyRules(configAt(level)).filter(
        (rule) => !rule.includes('/**)'),
      );

      expect(documentRules).toEqual(
        versionCarryingDocuments(level).map((name) => `Edit(/internal/docs/${name})`),
      );
    },
  );

  it('denies SRS and SDD at full and neither at standard', () => {
    expect(documentDenyRules(configAt('full')).join('\n')).toContain('SRS.md');
    expect(documentDenyRules(configAt('standard')).join('\n')).not.toContain('SRS.md');
    expect(documentDenyRules(configAt('standard')).join('\n')).toContain('CHARTER.md');
  });

  it('follows the contract document root wherever it points', () => {
    expect(documentDenyRules(configAt('full', 'docs')).join('\n')).toContain('Edit(/docs/SRS.md)');
  });
});

describe('every generated document rule uses the Edit form with an explicit anchor', () => {
  it('holds for the generator', () => {
    for (const level of ['light', 'standard', 'full'] as const) {
      expectDenialForm(documentDenyRules(configAt(level)));
    }
  });

  it('fails when the generator is mutated to emit Write(', () => {
    // A `Write(path)` rule is never matched by the file permission checks: it
    // denies nothing while reading as though it denied everything (A.2). That
    // is the mutation this assertion exists to catch, so it is run against one.
    const mutated = documentDenyRules(configAt('full')).map((rule) =>
      rule.replace(/^Edit\(/, 'Write('),
    );

    expect(() => expectDenialForm(mutated)).toThrowError();
  });

  it('fails when the generator is mutated to drop the anchor', () => {
    const mutated = documentDenyRules(configAt('full')).map((rule) => rule.replace('(/', '('));

    expect(() => expectDenialForm(mutated)).toThrowError();
  });
});

describe('the Implementer carries the denial and the PM does not', () => {
  it('denies the document set to the Implementer', () => {
    const deny = rolePermissions('implementer', configAt('full')).deny;

    for (const rule of documentDenyRules(configAt('full'))) expect(deny).toContain(rule);
  });

  it('leaves the PM able to write the documents it owns', () => {
    const deny = rolePermissions('pm', configAt('full')).deny;

    expect(deny.join('\n')).not.toContain('SRS.md');
  });

  it('denies the runtime records to both, which no role session writes', () => {
    for (const role of ROLES) {
      expect(rolePermissions(role, configAt('full')).deny).toContain('Edit(/.wardroom/run/**)');
    }
  });
});

describe('a bare tool name is refused where that tool can reach a gate class', () => {
  it('refuses a bare Bash, naming the tool and what it reaches', () => {
    expect(() => checkAllowRules('implementer', ['Bash'])).toThrowError(PermissionRuleRefusedError);
    expect(() => checkAllowRules('implementer', ['Bash'])).toThrowError(/Bash/);
    expect(() => checkAllowRules('implementer', ['Bash'])).toThrowError(/push/);
  });

  it.each(Object.keys(GATE_REACHING_TOOLS))('refuses a bare %s', (tool) => {
    expect(() => checkAllowRules('implementer', [tool])).toThrowError(PermissionRuleRefusedError);
  });

  it('accepts the same tool scoped', () => {
    expect(() => checkAllowRules('implementer', ['Bash(npm run test)'])).not.toThrow();
  });

  it('accepts a bare name for a tool that reaches no gate class', () => {
    expect(gateClassesReachableBy('Glob')).toEqual([]);
    expect(() => checkAllowRules('pm', ['Glob'])).not.toThrow();
  });

  it('holds for the allow list every role is actually built with', () => {
    for (const role of ROLES) {
      for (const level of ['light', 'standard', 'full'] as const) {
        expect(() =>
          checkAllowRules(role, rolePermissions(role, configAt(level)).allow),
        ).not.toThrow();
      }
    }
  });

  it('reaches the shell to push, which is the case A.2 warns about by name', () => {
    expect(gateClassesReachableBy('Bash')).toContain('push');
  });
});
