import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { type BlockEditVerdict, classifyBlockEdit } from './block-edit.js';
import { parseOpenTourBlock } from './open-tour.js';

/**
 * What a proposed write would do to the open-tour block (SDD §4.2, D-95).
 *
 * The permission rules decide which file may be written; this decides what the
 * write may do to the one table inside it. The two are different questions and
 * only the first is expressible as a path rule, which is why D-44's
 * enumeration leaves PROGRESS writable and the rest of the Implementer's
 * exception is checked here.
 *
 * The `after` text is computed from the call rather than observed, because the
 * check has to run before the write happens: a check that read the result
 * would be reading a file the rule had already been broken in.
 *
 * **This is a floor and not a fence**, in the same sense as the supplier's
 * repository rule (§4.2, D-69). It reads the file tools, whose target is a
 * field; a shell command can write the same file without any argument saying
 * so, and no reading of a command line settles that. What stands behind it is
 * the same thing that stands behind D-69: the tool surface decides what exists
 * to call, the deny rules hold in every mode, and this is the line that catches
 * the ordinary case rather than the only one.
 */

/** The section a block edit is confined to, located the same way the reader does. */
const OPEN_TOUR_HEADING = '## Open tour';

export type ProgressWrite =
  /** The call does not write PROGRESS, so this check has nothing to say. */
  | { readonly kind: 'not-progress' }
  /** The call writes PROGRESS and this is what it would do to the block. */
  | { readonly kind: 'block'; readonly verdict: BlockEditVerdict };

/**
 * The file-writing tools a role actually has, and the field each names its
 * target in.
 *
 * The two in `roleDefinition`'s surface and no others. Listing tools no role
 * carries would read as coverage this has not got: the surface is what decides
 * what exists to call (Appendix A.2), and a name here that is not in it is a
 * guess about a tool nobody can invoke.
 */
const WRITE_TOOLS: Record<string, 'file_path'> = {
  Edit: 'file_path',
  Write: 'file_path',
};

function field(input: Record<string, unknown>, name: string): string | null {
  const value = input[name];
  return typeof value === 'string' ? value : null;
}

/** Whether the call names the PROGRESS file under this project's document root. */
function targetsProgress(root: string, docRoot: string, path: string): boolean {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  return relative(resolve(join(root, docRoot, 'PROGRESS.md')), resolve(absolute)) === '';
}

/** The Open tour section's body, or the whole text where the file has no such section. */
function openTourSection(text: string): string {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.trim() === OPEN_TOUR_HEADING);
  if (at === -1) return '';
  let end = lines.length;
  for (let index = at + 1; index < lines.length; index += 1) {
    if ((lines[index] as string).startsWith('## ')) {
      end = index;
      break;
    }
  }
  return lines.slice(at + 1, end).join('\n');
}

/**
 * The file as the call would leave it, or null where that cannot be worked out.
 *
 * `Edit` is applied the way the tool applies it, a literal replacement of
 * `old_string` by `new_string`, so the text checked here is the text that would
 * be written. Where the replacement does not match, the tool would fail anyway
 * and there is nothing to judge.
 */
function textAfter(
  toolName: string,
  input: Record<string, unknown>,
  before: string,
): string | null {
  if (toolName === 'Write') return field(input, 'content');

  const oldString = field(input, 'old_string');
  const newString = field(input, 'new_string');
  if (oldString === null || newString === null) return null;
  if (!before.includes(oldString)) return null;
  return input.replace_all === true
    ? before.split(oldString).join(newString)
    : before.replace(oldString, newString);
}

export interface ProgressWriteInput {
  readonly root: string;
  readonly docRoot: string;
  readonly toolName: string;
  readonly toolInput: unknown;
}

/**
 * Answers what a call would do to the open-tour block.
 *
 * A call this cannot read is reported as an unreadable block edit rather than
 * waved through: the point of the check is that only two changes are allowed,
 * and "the check could not tell" is not one of them.
 */
export function checkProgressWrite(input: ProgressWriteInput): ProgressWrite {
  const pathField = WRITE_TOOLS[input.toolName];
  if (pathField === undefined) return { kind: 'not-progress' };
  if (typeof input.toolInput !== 'object' || input.toolInput === null) {
    return { kind: 'not-progress' };
  }

  const record = input.toolInput as Record<string, unknown>;
  const path = field(record, pathField);
  if (path === null || !targetsProgress(input.root, input.docRoot, path)) {
    return { kind: 'not-progress' };
  }

  let before: string;
  try {
    before = readFileSync(resolve(join(input.root, input.docRoot, 'PROGRESS.md')), 'utf8');
  } catch {
    return {
      kind: 'block',
      verdict: {
        allowed: false,
        reason:
          'PROGRESS.md cannot be read, so what the write changes cannot be established, and the block is where resumption reads the job list (SRS §3.5, FR-1.2).',
      },
    };
  }

  const after = textAfter(input.toolName, record, before);
  if (after === null) {
    return {
      kind: 'block',
      verdict: {
        allowed: false,
        reason: `a ${input.toolName} call on PROGRESS.md whose effect cannot be read is refused rather than allowed: the exception is two named changes to the open-tour block, and "the check could not tell" is not one of them (SDD §4.2, D-95).`,
      },
    };
  }

  return {
    kind: 'block',
    verdict: classifyBlockEdit(
      parseOpenTourBlock(openTourSection(before)),
      parseOpenTourBlock(openTourSection(after)),
    ),
  };
}
