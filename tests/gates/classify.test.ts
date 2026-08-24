import { describe, expect, it } from 'vitest';
import { GATE_REACHING_TOOLS, classifyToolCall } from '../../src/gates/classify.js';

/**
 * Classifying a tool call against TD-2 (SDD §4.2, D-43).
 *
 * The two mistakes here are not symmetric. Classifying an ordinary call as a
 * gate costs a notification; failing to classify a gated one costs a silent
 * push. So the ungated cases below are as much the subject of this file as the
 * gated ones: every one of them is a call that must reach the model's hands
 * untouched, and each is here because the pattern beside it nearly catches it.
 */

function classify(toolName: string, toolInput: unknown) {
  return classifyToolCall(toolName, toolInput);
}

function bash(command: string) {
  return classify('Bash', { command });
}

describe('git push and remote operations classify as push', () => {
  it('classifies a push with its remote and branch', () => {
    const found = bash('git push origin main');

    expect(found?.gateClass).toBe('push');
    expect(found?.detail).toEqual({ kind: 'push', remote: 'origin', branch: 'main' });
  });

  it('classifies a bare push, leaving the remote and branch for the preview to resolve', () => {
    expect(bash('git push')?.detail).toEqual({ kind: 'push', remote: null, branch: null });
  });

  it('classifies a force push', () => {
    expect(bash('git push --force origin main')?.gateClass).toBe('push');
  });

  it('classifies a remote being added, which TD-2 names beside push', () => {
    expect(bash('git remote add origin https://example.invalid/r.git')?.gateClass).toBe('push');
  });

  it('does not classify reading the remotes', () => {
    expect(bash('git remote -v')).toBeNull();
  });

  it('does not classify a commit, which is not a remote operation', () => {
    expect(bash('git commit -m "feat: something"')).toBeNull();
  });

  it('states the rule that classified it, not only that it did', () => {
    expect(bash('git push origin main')?.why).toMatch(/TD-2/);
    expect(bash('git push origin main')?.what).toMatch(/origin/);
  });
});

describe('destructive commands classify as destructive', () => {
  it.each(['rm -rf build', 'git clean -fdx', 'git reset --hard HEAD~3', 'git stash'])(
    'classifies %s',
    (command) => {
      expect(bash(command)?.gateClass).toBe('destructive');
    },
  );

  it('carries the exact command, which is the preview TD-2 requires', () => {
    expect(bash('rm -rf build')?.detail).toEqual({
      kind: 'destructive',
      command: 'rm -rf build',
    });
  });

  it('does not classify removing one named file', () => {
    expect(bash('rm build/out.js')).toBeNull();
  });

  it('does not classify a soft reset, which loses nothing', () => {
    expect(bash('git reset --soft HEAD~1')).toBeNull();
  });
});

describe('touching the secrets file classifies as secrets', () => {
  it('classifies reading it through the shell', () => {
    expect(bash('cat .env')?.gateClass).toBe('secrets');
  });

  it('classifies reading it through the file tool', () => {
    const found = classify('Read', { file_path: '/repo/.env' });

    expect(found?.gateClass).toBe('secrets');
    expect(found?.detail).toEqual({
      kind: 'secrets',
      secret: '/repo/.env',
      call: 'Read(/repo/.env)',
    });
  });

  it('carries the call rather than a direction it would have to guess (D-54)', () => {
    // The direction was derived from shell redirection, so a command writing
    // by another route was reported as a read. The call is a fact; the
    // direction was not.
    expect(classify('Write', { file_path: '/repo/.env.production' })?.detail).toEqual({
      kind: 'secrets',
      secret: '/repo/.env.production',
      call: 'Write(/repo/.env.production)',
    });
  });

  it('still says read or write in the line the owner reads', () => {
    // Dropped from the preview, not from the wording: a tool name does say
    // which it is, and the what line is prose rather than evidence.
    expect(classify('Write', { file_path: '/repo/.env' })?.what).toMatch(/^Write /);
    expect(classify('Read', { file_path: '/repo/.env' })?.what).toMatch(/^Read /);
  });

  it('does not classify the shape file, which carries no value', () => {
    expect(classify('Read', { file_path: '/repo/.env.example' })).toBeNull();
    expect(bash('cat .env.example')).toBeNull();
  });

  it('does not classify an ordinary source file whose name merely contains env', () => {
    expect(classify('Read', { file_path: '/repo/src/environment.ts' })).toBeNull();
  });
});

describe('an ordinary call is not classified at all', () => {
  it.each([
    ['Bash', { command: 'npm run test' }],
    ['Bash', { command: 'git status --short' }],
    ['Read', { file_path: '/repo/src/index.ts' }],
    ['Edit', { file_path: '/repo/src/index.ts' }],
    ['Glob', { pattern: '**/*.ts' }],
  ])('leaves %s untouched', (tool, input) => {
    expect(classify(tool, input)).toBeNull();
  });

  it('answers null rather than throwing for an input it cannot read', () => {
    expect(classify('Bash', undefined)).toBeNull();
    expect(classify('Bash', { command: 42 })).toBeNull();
  });
});

describe('the classifier and the allow-list check read the same table', () => {
  it('classifies only through tools the table says reach a class', () => {
    for (const tool of ['Bash', 'Read', 'Write']) {
      expect(Object.keys(GATE_REACHING_TOOLS)).toContain(tool);
    }
  });

  it('never classifies through a tool the table leaves out', () => {
    expect(classify('Glob', { pattern: '.env' })).toBeNull();
  });
});

describe('a wrapper in front of the command does not hide it', () => {
  it('sees through sudo', () => {
    expect(bash('sudo rm -rf /var/lib/thing')?.gateClass).toBe('destructive');
    expect(bash('sudo git push origin main')?.gateClass).toBe('push');
  });

  it('still reports the command the owner would actually run', () => {
    expect(bash('sudo rm -rf build')?.detail).toEqual({
      kind: 'destructive',
      command: 'sudo rm -rf build',
    });
  });
});
