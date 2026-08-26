import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OPERATION_NAMES } from '../../src/api/operations.js';
import { COMMANDS, parseArgs } from '../../src/cli/args.js';
import { EXIT_FAILED, EXIT_OK, EXIT_STATE, runCli } from '../../src/cli/main.js';
import { PROJECT_MARKER, resolveProject } from '../../src/cli/resolve.js';
import { wardroomPaths } from '../../src/config/paths.js';
import type { QueryFn } from '../../src/roles/assembly.js';
import {
  GATE_ID,
  gateEntry,
  given,
  makeProject,
  writeGateEntry,
  writeProgress,
  writeUsageLines,
} from '../api/support.js';

/**
 * The v1 CLI (SDD §5.2, FR-5.1, D-109).
 *
 * The binding is mechanical: one command per operation, and no command that
 * reaches past the API into orchestrator internals. That last part is checked
 * structurally below rather than command by command, because a command that
 * reached past the API would still pass every behavioural case: it would
 * simply do the right thing by the wrong route, and the next surface would not
 * be able to.
 */

let root: string;

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** A seam that answers nothing, so `run` reaches the loop and never the API. */
const query: QueryFn = () =>
  (async function* () {
    // An empty session: the drive gets no result and the cycle exits on it.
  })() as never;

beforeEach(() => {
  root = makeProject();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function cli(line: string, cwd: string = root) {
  return runCli(line === '' ? [] : line.split(' '), { cwd, query });
}

describe('one command per operation, and no command past the API (FR-5.1)', () => {
  it('names a command for every operation the API carries', () => {
    // §5.2's list and §5.1's table are two statements of one surface, and this
    // is what keeps them in step: an operation added without a command would
    // be a capability no surface can reach, and a command added without an
    // operation would be the CLI-only capability FR-5.1 forbids.
    const covered = new Set(COMMANDS);
    const missing = OPERATION_NAMES.filter((name) => {
      const command = name.split('.')[1] ?? '';
      const alias: Record<string, string> = {
        kickoff: 'init',
        list: 'gates',
        show: 'gate',
        decide: 'approve',
        inject: 'say',
        report: 'usage',
        log: 'log',
      };
      return !covered.has((alias[command] ?? command) as never);
    });

    expect(missing).toEqual([]);
  });

  it('imports nothing at runtime from outside src/cli except the operation set', () => {
    // The structural statement of "nothing reaches past the API". Type-only
    // imports are allowed: they erase at compile time and cannot call
    // anything, so a renderer may know the shape of what it renders. Node's
    // own built-ins are allowed too: §5.2 gives the surface the job of finding
    // which project a command acts on, and a directory search is not an
    // orchestrator internal.
    const offenders: string[] = [];
    const files = execFileSync('git', ['ls-files', '-z', 'src/cli'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.endsWith('.ts'));

    for (const path of files) {
      const source = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      for (const match of source.matchAll(/import\s+(type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"]/g)) {
        const statement = match[0] as string;
        const from = match[2] as string;
        if (/^import\s+type\b/.test(statement)) continue;
        if (from.startsWith('./')) continue;
        if (from.startsWith('node:')) continue;
        if (from === '../api/operations.js') continue;
        offenders.push(`${path}: ${statement}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('has files to check, so a passing run is not an empty one', () => {
    const files = execFileSync('git', ['ls-files', '-z', 'src/cli'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\0')
      .filter((path) => path.endsWith('.ts'));

    expect(files.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the project resolves from the nearest ancestor (D-109)', () => {
  it('finds the project from a directory inside it', () => {
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });

    expect(resolveProject(join(root, 'src', 'deep'), null)).toEqual({ kind: 'found', root });
  });

  it('finds it from the project root itself', () => {
    expect(resolveProject(root, null)).toEqual({ kind: 'found', root });
  });

  it('lets --project override the search', () => {
    expect(resolveProject('/', root)).toEqual({ kind: 'found', root });
  });

  it('takes --project literally rather than searching up from it', () => {
    // An owner who names a directory has said which project they mean.
    // Searching past it would act on a different project than the one they
    // named, which is the accident this rule exists to prevent.
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });

    const named = resolveProject('/', join(root, 'src', 'deep'));

    expect(named.kind).toBe('not-found');
  });

  it('exits 1 and names the directory it searched from', async () => {
    const elsewhere = makeProject();
    rmSync(join(elsewhere, '.wardroom'), { recursive: true, force: true });

    const result = await cli('status', elsewhere);

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.err.join('\n')).toContain(elsewhere);
    expect(result.err.join('\n')).toContain(PROJECT_MARKER);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it('says which directory --project named when that one holds no project', async () => {
    const elsewhere = makeProject();
    rmSync(join(elsewhere, '.wardroom'), { recursive: true, force: true });

    const result = await cli(`status --project ${elsewhere}`, root);

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.err.join('\n')).toContain(elsewhere);
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe('exit codes (D-109)', () => {
  it('exits 0 when a command did what it was asked', async () => {
    writeProgress(root);
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    expect((await cli('status')).exitCode).toBe(EXIT_OK);
    expect((await cli('config')).exitCode).toBe(EXIT_OK);
    expect((await cli('gates')).exitCode).toBe(EXIT_OK);
    expect((await cli('log')).exitCode).toBe(EXIT_OK);
    expect((await cli('usage')).exitCode).toBe(EXIT_OK);
  });

  it('exits 2 for a run stopped by a pending gate, not 1', async () => {
    // The case the third code exists for: a run blocked on a gate is the
    // system working, and a script treating it as a failure would be wrong as
    // often as it was right.
    writeProgress(root);
    writeGateEntry(root, gateEntry());
    given(root, {
      state: 'GATED',
      tourId: 'tour-4',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: GATE_ID,
    });

    const result = await cli('run');

    expect(result.exitCode).toBe(EXIT_STATE);
    expect(result.out.join('\n')).toMatch(/gate/i);
  });

  it('exits 2 for a parked tour', async () => {
    writeProgress(root);
    writeGateEntry(root, gateEntry({ parked_at: '2026-08-22T09:30:00.000Z' }));
    given(root, {
      state: 'PARKED',
      tourId: 'tour-4',
      jobIndex: 1,
      interruptedState: 'EXECUTING',
      gateId: GATE_ID,
    });

    expect((await cli('run')).exitCode).toBe(EXIT_STATE);
  });

  it('exits 2 for a resumption that could not be resolved', async () => {
    // The third of D-109's three: neither an error nor a success, but the
    // project's own state stopping the command.
    writeFileSync(wardroomPaths(root).stateFile, '{ truncated');

    const result = await cli('run');

    expect(result.exitCode).toBe(EXIT_STATE);
  });

  it('exits 1 when the command failed', async () => {
    const result = await cli(`gate ${GATE_ID}`);

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.err.join('\n')).toMatch(/g-20260821T093000Z-a1b2/);
  });

  it('exits 1 on a command nobody offers, naming what is on offer', async () => {
    const result = await cli('deploy');

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.err.join('\n')).toContain('is not a wardroom command');
    expect(result.err.join('\n')).toContain('status');
  });

  it('exits 1 for init, saying why rather than reporting a typo', async () => {
    // The command exists in §5.2 and the operation behind it does not exist
    // yet, and those are different facts.
    const result = await cli('init');

    expect(result.exitCode).toBe(EXIT_FAILED);
    expect(result.err.join('\n')).toMatch(/4\.7/);
  });

  it('exits 2 for a detach with nothing to stop, since that is the state answering', async () => {
    given(root, { state: 'IDLE' });

    const result = await cli('detach');

    expect(result.exitCode).toBe(EXIT_STATE);
    expect(result.out.join('\n')).toMatch(/Nothing was asked to stop/);
  });

  it('exits 0 for a detach that was recorded', async () => {
    given(root, { state: 'EXECUTING', tourId: 'tour-4', jobIndex: 1 });

    expect((await cli('detach')).exitCode).toBe(EXIT_OK);
  });
});

describe('the commands reach their operations', () => {
  it('shows the gate the owner asked for', async () => {
    writeGateEntry(root, gateEntry());
    given(root);

    const result = await cli(`gate ${GATE_ID}`);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.out.join('\n')).toContain('Push 3 commits to origin/main');
  });

  it('records a decision, with the note', async () => {
    writeGateEntry(root, gateEntry());
    given(root);

    // One token, because this harness splits on spaces where a shell would
    // have quoted; the parser takes the value after --note and no more.
    const result = await cli(`approve ${GATE_ID} --note looks-right`);

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.out.join('\n')).toMatch(/approved/);
    expect(result.out.join('\n')).toMatch(/looks-right/);
    // Read back through a second command, not out of the first one's answer.
    expect((await cli('gates')).out.join('\n')).toMatch(/No gate is waiting/);
  });

  it('records a rejection', async () => {
    writeGateEntry(root, gateEntry());
    given(root);

    expect((await cli(`reject ${GATE_ID}`)).out.join('\n')).toMatch(/rejected/);
  });

  it('records what the owner said, whole', async () => {
    const result = await cli('say the pilot repository moved to a new host');

    expect(result.exitCode).toBe(EXIT_OK);
    // The sentence, not its first word: an owner who typed a sentence without
    // quoting it meant the sentence.
    const written = readFileSync(wardroomPaths(root).inboxFile, 'utf8');
    expect(JSON.parse(written.trim()).text).toBe('the pilot repository moved to a new host');
  });

  it('reports usage for the tour asked for', async () => {
    writeUsageLines(root, [
      {
        kind: 'job',
        ts: '2026-08-21T09:00:00.000Z',
        role: 'implementer',
        state: 'EXECUTING',
        tour_id: 'tour-3',
        job_index: 0,
        session_id: 's-1',
        tokens: { input: 100, output: 10 },
        usd: 7,
      },
    ]);

    const result = await cli('usage --tour tour-3');

    expect(result.out.join('\n')).toContain('tour-3');
    expect(result.out.join('\n')).toContain('$7.00');
  });

  it('shows the green definition, which is what config is asked for', async () => {
    const result = await cli('config');

    expect(result.out.join('\n')).toContain('Green means all of:');
    expect(result.out.join('\n')).toContain('true');
  });
});

describe('the arguments a command takes', () => {
  it('refuses a decision with no gate named', () => {
    const parsed = parseArgs(['approve']);

    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' && parsed.message).toContain('<id>');
  });

  it('refuses an option with no value', () => {
    expect(parseArgs(['usage', '--tour']).kind).toBe('error');
  });

  it('refuses an argument on a command that takes none', () => {
    expect(parseArgs(['status', 'tour-4']).kind).toBe('error');
  });

  it('refuses a second word where one is expected', () => {
    expect(parseArgs(['gate', 'a', 'b']).kind).toBe('error');
  });

  it('joins the words of a said sentence and nothing else', () => {
    const parsed = parseArgs(['say', 'two', 'words', '--project', '/tmp/x']);

    expect(parsed.kind === 'ok' && parsed.parsed.argument).toBe('two words');
    expect(parsed.kind === 'ok' && parsed.parsed.project).toBe('/tmp/x');
  });

  it('refuses an option no command takes', () => {
    expect(parseArgs(['status', '--verbose']).kind).toBe('error');
  });

  it('answers with the usage line where nothing was typed', () => {
    const parsed = parseArgs([]);

    expect(parsed.kind === 'error' && parsed.message).toContain('usage: wardroom');
  });
});
