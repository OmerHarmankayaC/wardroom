import type { CanUseTool, Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '../../src/config/schema.js';
import {
  RoleSessionRefusedError,
  assembleSession,
  requiredAttachments,
} from '../../src/roles/assembly.js';

/**
 * The assembled session (SDD §4.2, D-43, D-53, D-56, D-85).
 *
 * A role that reaches a driver is built from three things and refuses to run
 * without any one of them: the role factory, the `PreToolUse` interception
 * hook, and the `canUseTool` supplier. The refusal is the point. Each of the
 * three is a line of the mechanism that holds a push, and a session missing
 * one still answers every question a session answers, so nothing downstream
 * would notice.
 *
 * The SDK call sits behind one seam, which is what a test may replace. No
 * case here reaches the network: D-85 makes a live run the owner's smoke test
 * and never the evidence a criterion rests on.
 */

const config: ProjectConfig = {
  name: 'example',
  level: 'full',
  docRoot: 'internal/docs',
  defaultBranch: 'main',
  stack: { language: 'TypeScript', runtime: 'node>=18', packageManager: 'npm' },
  verify: ['true'],
  authMode: 'api_key',
  gateWait: { value: 24, unit: 'h', milliseconds: 86_400_000 },
  attemptBudget: 3,
  usageBudget: { usd: 10 },
  trackRuntime: false,
};

/** A hook set shaped like the interception hook, which is all this needs. */
const hooks: Options['hooks'] = {
  PreToolUse: [{ hooks: [async () => ({ continue: true })] }],
};

const canUseTool: CanUseTool = async () => ({ behavior: 'allow', updatedInput: {} });

/** The seam: a query that yields what the test wrote and never opens a socket. */
function scriptedQuery(messages: readonly SDKMessage[] = []) {
  const calls: { prompt: unknown; options: Options | undefined }[] = [];
  const open = (params: { prompt: unknown; options?: Options }) => {
    calls.push({ prompt: params.prompt, options: params.options });
    return (async function* () {
      for (const message of messages) yield message;
    })() as unknown as Query;
  };
  return { calls, open };
}

function assemble(overrides: Record<string, unknown> = {}) {
  const scripted = scriptedQuery();
  return {
    scripted,
    session: assembleSession({
      role: 'implementer',
      config,
      root: '/tmp/example',
      hooks,
      canUseTool,
      query: scripted.open,
      ...overrides,
    }),
  };
}

describe('all three attachments are on the session', () => {
  it('builds from the role factory, so the contract reaches the options', () => {
    const { session } = assemble();

    expect(session.options.systemPrompt).toBeTruthy();
    expect(session.options.cwd).toBe('/tmp/example');
    expect(session.options.permissionMode).toBe('default');
  });

  it('attaches the interception hook', () => {
    const { session } = assemble();

    expect(session.options.hooks?.PreToolUse).toBeDefined();
  });

  it('attaches the canUseTool supplier', () => {
    const { session } = assemble();

    expect(session.options.canUseTool).toBe(canUseTool);
  });

  it('loads no settings from the filesystem', () => {
    // D-53: left unset, the SDK loads user, project and local settings, any of
    // which can carry an allow rule or a default mode that undoes the role.
    const { session } = assemble();

    expect(session.options.settingSources).toEqual([]);
  });

  it('names the three attachments in one place', () => {
    // The list the refusals below are generated from. Kept as data so that a
    // fourth attachment cannot be added to the builder without appearing here.
    expect(requiredAttachments).toEqual(['hooks', 'canUseTool', 'query']);
  });
});

describe('a role missing any one of them is refused rather than run', () => {
  for (const attachment of requiredAttachments) {
    it(`refuses to assemble without ${attachment}`, () => {
      expect(() => assemble({ [attachment]: undefined })).toThrow(RoleSessionRefusedError);
    });

    it(`says which attachment was missing, for ${attachment}`, () => {
      expect(() => assemble({ [attachment]: undefined })).toThrow(new RegExp(attachment));
    });
  }

  it('refuses a hook set that carries no PreToolUse entry', () => {
    // An empty hook set is the shape that would pass a presence check and
    // intercept nothing, which is the silent failure D-43 exists to prevent:
    // every call would reach the tool with no gate raised anywhere.
    expect(() => assemble({ hooks: {} })).toThrow(RoleSessionRefusedError);
  });

  it('refuses a PreToolUse entry with no hook in it', () => {
    expect(() => assemble({ hooks: { PreToolUse: [{ hooks: [] }] } })).toThrow(
      RoleSessionRefusedError,
    );
  });

  it('refuses a banned permission mode, as the factory does', () => {
    expect(() => assemble({ permissionMode: 'bypassPermissions' })).toThrow(
      RoleSessionRefusedError,
    );
  });
});

describe('the SDK call sits behind one seam', () => {
  it('opens the query through the seam it was given, with the assembled options', () => {
    const { scripted, session } = assemble();

    session.open('do the job');

    expect(scripted.calls).toHaveLength(1);
    expect(scripted.calls[0]?.prompt).toBe('do the job');
    expect(scripted.calls[0]?.options).toBe(session.options);
  });

  it('opens nothing until it is asked to', () => {
    const { scripted } = assemble();

    expect(scripted.calls).toHaveLength(0);
  });

  it('yields the messages the seam produced, in order', async () => {
    const scripted = scriptedQuery([
      { type: 'system', subtype: 'init' } as unknown as SDKMessage,
      { type: 'result', subtype: 'success' } as unknown as SDKMessage,
    ]);
    const session = assembleSession({
      role: 'pm',
      config,
      root: '/tmp/example',
      hooks,
      canUseTool,
      query: scripted.open,
    });

    const seen: string[] = [];
    for await (const message of session.open('plan')) seen.push(message.type);

    expect(seen).toEqual(['system', 'result']);
  });

  it('reaches no network from this suite', () => {
    // The seam is the only route out, so a session assembled without one is
    // refused above rather than falling back to the real SDK. Stated as a case
    // because "no live API call" is a rule about this suite (D-85), not a
    // property any single assertion above would notice breaking.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { session } = assemble();

    session.open('do the job');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
