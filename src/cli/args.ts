/**
 * The v1 command line, parsed (SDD §5.2).
 *
 * The binding is mechanical: one command per operation, no command that
 * reaches past the API into orchestrator internals. A CLI-only capability
 * would be a violation of FR-5.1, not a convenience, so this module decides
 * only what the owner typed and never what it means.
 *
 * No dependency, no framework. The grammar is a dozen commands and three
 * options; a parser library would be a second grammar to keep in step with
 * this document's list.
 */

/** The commands SDD §5.2 names, in the order it names them. */
export const COMMANDS = [
  'init',
  'run',
  'status',
  'gates',
  'gate',
  'approve',
  'reject',
  'say',
  'usage',
  'log',
  'config',
  'detach',
] as const;
export type CommandName = (typeof COMMANDS)[number];

export interface ParsedCommand {
  readonly command: CommandName;
  /** The positional argument the command takes, or null where it takes none. */
  readonly argument: string | null;
  /** `--project <path>`, which overrides the search from the working directory. */
  readonly project: string | null;
  /** `--note <text>` for a decision (FR-3.2 records it). */
  readonly note: string | null;
  /** `--tour <id>` for the usage report. */
  readonly tour: string | null;
}

export type ParseResult =
  | { readonly kind: 'ok'; readonly parsed: ParsedCommand }
  | { readonly kind: 'error'; readonly message: string };

function isCommand(word: string): word is CommandName {
  return (COMMANDS as readonly string[]).includes(word);
}

/** The usage line, generated from the command list so the two cannot drift. */
export function usageLine(): string {
  return `usage: wardroom <${COMMANDS.join(' | ')}> [--project <path>] [--note <text>] [--tour <id>]`;
}

/** Which commands take a positional argument, and what it is called. */
const ARGUMENT_OF: Partial<Record<CommandName, string>> = {
  gate: '<id>',
  approve: '<id>',
  reject: '<id>',
  say: '<text>',
};

/**
 * Reads the arguments after the program name.
 *
 * `say` is the one command whose argument may contain spaces, so the rest of
 * the line after the options is joined rather than the first word taken: an
 * owner who typed a sentence without quoting it meant the sentence.
 */
export function parseArgs(argv: readonly string[]): ParseResult {
  const words = [...argv];
  if (words.length === 0) return { kind: 'error', message: usageLine() };

  const head = words.shift() as string;
  if (!isCommand(head)) {
    return {
      kind: 'error',
      message: `${JSON.stringify(head)} is not a wardroom command.\n${usageLine()}`,
    };
  }

  let project: string | null = null;
  let note: string | null = null;
  let tour: string | null = null;
  const positional: string[] = [];

  while (words.length > 0) {
    const word = words.shift() as string;
    if (word === '--project' || word === '--note' || word === '--tour') {
      const value = words.shift();
      if (value === undefined) {
        return { kind: 'error', message: `${word} needs a value.\n${usageLine()}` };
      }
      if (word === '--project') project = value;
      else if (word === '--note') note = value;
      else tour = value;
      continue;
    }
    if (word.startsWith('--')) {
      return {
        kind: 'error',
        message: `${JSON.stringify(word)} is not an option this command takes.\n${usageLine()}`,
      };
    }
    positional.push(word);
  }

  const expected = ARGUMENT_OF[head];
  if (expected !== undefined && positional.length === 0) {
    return { kind: 'error', message: `${head} needs ${expected}.\n${usageLine()}` };
  }
  if (expected === undefined && positional.length > 0) {
    return {
      kind: 'error',
      message: `${head} takes no argument, and ${JSON.stringify(positional[0] as string)} was given.\n${usageLine()}`,
    };
  }

  // Only `say` joins: everything else takes one word, and a second word there
  // is a typo worth reporting rather than silently ignoring.
  if (expected !== undefined && head !== 'say' && positional.length > 1) {
    return {
      kind: 'error',
      message: `${head} takes one argument, and ${positional.length} were given.\n${usageLine()}`,
    };
  }

  return {
    kind: 'ok',
    parsed: {
      command: head,
      argument: expected === undefined ? null : positional.join(' '),
      project,
      note,
      tour,
    },
  };
}
