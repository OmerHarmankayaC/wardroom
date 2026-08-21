import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPermissionSupplier } from '../../src/roles/supplier.js';

/**
 * The `canUseTool` supplier (SDD §4.2, D-56).
 *
 * The allow list is deliberately narrow, so this is not a redundancy behind
 * the hook: it is the path almost every ordinary call takes, and a session
 * with no supplier configured cannot act at all. Its policy therefore belongs
 * to the design and is tested against the design, not against whatever the
 * orchestrator happens to pass.
 */

let root: string;
let outside: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-supplier-'));
  outside = mkdtempSync(join(tmpdir(), 'wardroom-elsewhere-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/**
 * The denial's message, or a stated absence. One helper rather than the
 * narrowing dance repeated at every assertion, which is how a test file grows
 * its own small dialect.
 */
function denialMessage(result: PermissionResult | null): string {
  if (result === null) return '<no answer at all>';
  return result.behavior === 'deny' ? result.message : '<the call was approved>';
}

/**
 * Asks, and refuses a null answer on the way out.
 *
 * The SDK sends no control response for a null, so the tool stays blocked
 * indefinitely and a permission prompt has no park deadline. A supplier that
 * can return null is a supplier that can hang a session with no record of why,
 * which is the silent form of the failure the gate queue exists to prevent.
 */
async function ask(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
  const answer = await createPermissionSupplier({ root })(toolName, input, {
    signal: new AbortController().signal,
    toolUseID: 'tu-1',
    requestId: 'req-1',
  });

  expect(answer, `${toolName} was left with no answer at all`).not.toBeNull();
  return answer as PermissionResult;
}

describe('an ordinary call inside the repository is approved', () => {
  it.each([
    ['Read', { file_path: 'src/index.ts' }],
    ['Edit', { file_path: 'src/roles/supplier.ts' }],
    ['Write', { file_path: 'tests/roles/supplier.test.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['Grep', { pattern: 'export', path: 'src' }],
  ])('approves %s', async (tool, input) => {
    await expect(ask(tool, input)).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('approves an absolute path that resolves inside the repository', async () => {
    await expect(ask('Read', { file_path: join(root, 'src', 'index.ts') })).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('approves the package manager, which is how a session runs anything', async () => {
    await expect(ask('Bash', { command: 'npm run build' })).resolves.toMatchObject({
      behavior: 'allow',
    });
  });

  it('approves a call it cannot read a path out of at all', async () => {
    // A tool whose input names no path reaches nothing outside by definition
    // of what this check can see, and denying it would stop the session over
    // a parser gap rather than over a policy.
    await expect(ask('Glob', {})).resolves.toMatchObject({ behavior: 'allow' });
  });
});

describe('a call reaching outside the repository is denied, naming the path', () => {
  it('denies an absolute path outside the root', async () => {
    const target = join(outside, 'secrets.txt');
    const result = await ask('Read', { file_path: target });

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toContain(target);
  });

  it('denies a relative path that climbs out', async () => {
    const result = await ask('Edit', { file_path: '../elsewhere/notes.md' });

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toMatch(/elsewhere/);
  });

  it('denies a shell command whose argument climbs out', async () => {
    const result = await ask('Bash', { command: 'cat ../../etc/hosts' });

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toMatch(/etc\/hosts/);
  });

  it('denies a shell command that changes directory out of the repository', async () => {
    const result = await ask('Bash', { command: `cd ${outside} && ls` });

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toContain(outside);
  });

  it('names the repository it is protecting, so the denial can be acted on', async () => {
    const result = await ask('Read', { file_path: '/etc/passwd' });

    expect(denialMessage(result)).toContain(root);
  });

  it('does not mistake a sibling directory sharing the root name prefix', async () => {
    // `/tmp/repo-other` starts with `/tmp/repo` as a string and is not inside
    // it. A prefix comparison would approve it.
    const sibling = `${root}-other/file.ts`;
    const result = await ask('Read', { file_path: sibling });

    expect(result.behavior).toBe('deny');
  });
});

describe('a gate-classified call never reaches an approval here', () => {
  it.each([
    ['Bash', { command: 'git push origin main' }],
    ['Bash', { command: 'rm -rf build' }],
    ['Read', { file_path: '.env' }],
  ])('denies %s as a classifier defect', async (tool, input) => {
    const result = await ask(tool, input);

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toMatch(/hook|classif/i);
  });

  it('denies it even though the path is inside the repository', async () => {
    // The point of the case: `.env` is an ordinary in-repository path, so the
    // inside/outside rule would approve it. The hook catches gate classes
    // before the mode is reached, so one arriving here is a defect upstream
    // and is denied with that as the reason rather than judged by a mechanism
    // that was never meant to judge it (SDD §4.2, D-56).
    const result = await ask('Read', { file_path: join(root, '.env') });

    expect(result.behavior).toBe('deny');
    expect(denialMessage(result)).toMatch(/secrets/);
  });
});

describe('the supplier is orchestrator code and never a model', () => {
  it('reaches no network while answering', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await ask('Read', { file_path: 'src/index.ts' });
    await ask('Read', { file_path: '/etc/passwd' });
    await ask('Bash', { command: 'git push origin main' });

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('always answers, because a null answer blocks the tool with no deadline', async () => {
    // The SDK sends no control response for a null and a permission prompt has
    // no park deadline, so a null hangs the session with nothing on disk
    // saying why.
    for (const [tool, request] of [
      ['Read', { file_path: 'src/index.ts' }],
      ['Read', { file_path: '/etc/passwd' }],
      ['Bash', { command: 'git push origin main' }],
      ['Glob', {}],
      ['Unknown', { nothing: true }],
    ] as const) {
      await expect(ask(tool, request)).resolves.not.toBeNull();
    }
  });

  it('answers the same way twice, because nothing it consults can change', async () => {
    const first = await ask('Read', { file_path: '/etc/passwd' });
    const second = await ask('Read', { file_path: '/etc/passwd' });

    expect(first).toEqual(second);
  });
});
