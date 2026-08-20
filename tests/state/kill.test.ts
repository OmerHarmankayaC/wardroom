import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { wardroomPaths } from '../../src/config/paths.js';
import { readMarker } from '../../src/state/marker.js';

/**
 * BACKLOG D-20, the durability half. The marker is the file most likely to be
 * caught mid-write, because it is written at exactly the boundaries where the
 * process is doing something else dangerous — and it is the file resumption
 * depends on. A real process, really killed, is the only evidence that the
 * atomic write holds.
 *
 * Killing at a random moment mostly misses the write window, so the decisive
 * test does not rely on luck: it stops the writer, confirms from the frozen
 * filesystem that it is between creating its temporary file and renaming it,
 * and only then kills it.
 */

const repoRoot = resolve(import.meta.dirname, '../..');
const writerScript = resolve(import.meta.dirname, 'marker-writer.mjs');

let root: string;
let child: ChildProcess | undefined;

beforeAll(() => {
  // The child runs the shipped build, so it needs no TypeScript loader.
  execFileSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'pipe' });
}, 120_000);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wardroom-kill-'));
});

afterEach(() => {
  child?.kill('SIGKILL');
  child = undefined;
  rmSync(root, { recursive: true, force: true });
});

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await pause(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts the writer and resolves once it has produced at least one marker. */
async function startWriter(): Promise<ChildProcess> {
  const started = spawn(process.execPath, [writerScript, root], { stdio: 'pipe' });
  await waitFor(() => existsSync(wardroomPaths(root).stateFile), 'the first marker to be written');
  return started;
}

function exited(process_: ChildProcess): Promise<void> {
  return new Promise((done) => process_.once('exit', () => done()));
}

/** Temporary files the writer creates and renames away. */
function temporaries(): string[] {
  return readdirSync(wardroomPaths(root).runDir).filter((entry) => entry.endsWith('.tmp'));
}

/** The kernel's view of a process: `T` once it is stopped. */
function isStopped(pid: number): boolean {
  try {
    return execFileSync('ps', ['-o', 'state=', '-p', String(pid)], {
      encoding: 'utf8',
    })
      .trim()
      .startsWith('T');
  } catch {
    return false;
  }
}

/**
 * Kills the writer at a moment proven to be inside a marker write.
 *
 * SIGSTOP cannot be caught or ignored, so a stopped writer's directory is a
 * frozen picture: a temporary file present there means the process is between
 * writing it and renaming it over the marker. That is the instant the atomic
 * write exists for, and the only instant worth killing at. The writer is never
 * continued once that instant is found — SIGKILL reaps a stopped process, and
 * resuming it first would let it finish the very rename being interrupted.
 */
async function killInsideAWrite(writer: ChildProcess): Promise<void> {
  const pid = writer.pid;
  if (pid === undefined) throw new Error('the writer never started');

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    writer.kill('SIGSTOP');
    await waitFor(() => isStopped(pid), 'the writer to stop');

    if (temporaries().length > 0) {
      writer.kill('SIGKILL');
      await exited(writer);
      return;
    }

    writer.kill('SIGCONT');
    await pause(0);
  }
  throw new Error('never caught the writer between writing its temporary file and renaming it');
}

describe('the state marker under process death', () => {
  it("is written through a temporary file in the marker's own directory", async () => {
    child = await startWriter();

    // Captured at the moment it is seen: the writer renames the file away
    // immediately, so re-reading the directory afterwards proves nothing.
    let observed: string[] = [];
    await waitFor(() => {
      observed = temporaries();
      return observed.length > 0;
    }, 'a temporary file to appear beside the marker');

    expect(observed.every((entry) => entry.includes('state.json'))).toBe(true);
  });

  it('survives a SIGKILL delivered inside the write itself', async () => {
    for (let round = 0; round < 5; round++) {
      rmSync(root, { recursive: true, force: true });
      child = await startWriter();

      await killInsideAWrite(child);
      child = undefined;

      // The temporary file is still there: this really was a mid-write death.
      expect(temporaries().length, `round ${round} did not die mid-write`).toBeGreaterThan(0);
      const read = readMarker(root);
      expect(read.kind, `round ${round} left a marker that could not be read`).toBe('ok');
      expect(read.kind === 'ok' && read.marker.state).toBe('EXECUTING');
    }
  }, 120_000);

  it('never leaves an unreadable marker across repeated kills at arbitrary moments', async () => {
    for (let round = 0; round < 20; round++) {
      rmSync(root, { recursive: true, force: true });
      child = await startWriter();
      await pause(round % 7);

      child.kill('SIGKILL');
      await exited(child);
      child = undefined;

      const read = readMarker(root);
      expect(read.kind, `round ${round} left a marker that could not be read`).toBe('ok');
      expect(read.kind === 'ok' && Number.isInteger(read.marker.attemptCount)).toBe(true);
    }
  }, 120_000);
});
