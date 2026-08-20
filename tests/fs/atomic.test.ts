import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { atomicWriteFile } from '../../src/fs/atomic.js';

/**
 * The write mechanism every durable record shares (SDD §3.3, BACKLOG D-20).
 * What it owes its callers is a file that is either wholly the old contents or
 * wholly the new ones, and a directory with no debris left behind when it is.
 */

let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wardroom-atomic-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('atomicWriteFile', () => {
  it('creates a target that did not exist', () => {
    const target = join(directory, 'record.json');

    atomicWriteFile(target, '{"a":1}');

    expect(readFileSync(target, 'utf8')).toBe('{"a":1}');
  });

  it('replaces an existing target whole', () => {
    const target = join(directory, 'record.json');
    atomicWriteFile(target, 'a much longer set of previous contents');

    atomicWriteFile(target, 'short');

    expect(readFileSync(target, 'utf8')).toBe('short');
  });

  it('leaves no temporary file behind', () => {
    const target = join(directory, 'record.json');

    atomicWriteFile(target, 'one');
    atomicWriteFile(target, 'two');

    expect(readdirSync(directory)).toEqual(['record.json']);
  });

  it('cleans up its temporary file when the rename fails', () => {
    // A directory at the target path is a rename the filesystem refuses.
    const target = join(directory, 'occupied');
    mkdirSync(join(target, 'child'), { recursive: true });

    expect(() => atomicWriteFile(target, 'anything')).toThrow();

    expect(readdirSync(directory)).toEqual(['occupied']);
  });

  it('does not truncate the target when the write fails', () => {
    const target = join(directory, 'record.json');
    atomicWriteFile(target, 'the contents that must survive');

    const readOnly = join(directory, 'locked');
    mkdirSync(readOnly);
    chmodSync(readOnly, 0o500);
    try {
      expect(() => atomicWriteFile(join(readOnly, 'record.json'), 'nope')).toThrow();
    } finally {
      chmodSync(readOnly, 0o700);
    }

    expect(readFileSync(target, 'utf8')).toBe('the contents that must survive');
  });
});
