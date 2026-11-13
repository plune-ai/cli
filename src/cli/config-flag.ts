// The program has a global `-c, --config <path>` (the plune.yaml of `plune run`). A few subcommands (`mcp conformance`,
// `mcp scan`) have a `--config` of their own, and commander gives one written after the subcommand to the global
// option: the subcommand never sees it, and the program would load the `.env` beside it. Which `--config` is whose
// is told here from the arguments, by position: before the subcommand it is the program's, after it the subcommand's.

export interface ConfigFlagValues {
  /** `-c`/`--config` before the subcommand: the program's. */
  before: string[];
  /** `--config` after it, up to `--`: the subcommand's, in order. */
  after: string[];
}

/** `path` is the subcommand as typed, such as `['mcp', 'scan']`. */
export function configFlagValues(
  args: readonly string[],
  path: readonly string[],
): ConfigFlagValues {
  const out: ConfigFlagValues = { before: [], after: [] };
  let next = 0;
  let side: keyof ConfigFlagValues = 'before';
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') break;
    if (side === 'before' && arg === path[next]) {
      next += 1;
      if (next === path.length) side = 'after';
      continue;
    }
    const long = arg.startsWith('--config=') ? arg.slice('--config='.length) : undefined;
    if (long !== undefined) out[side].push(long);
    else if ((arg === '--config' || (side === 'before' && arg === '-c')) && i + 1 < args.length)
      out[side].push(args[++i]!);
  }
  return out;
}

/** The commands that have a `--config` of their own, by the words that name them; undefined for any other command. */
export function subcommandPath(command: {
  name(): string;
  parent: { name(): string } | null;
}): string[] | undefined {
  const name = command.name();
  return command.parent?.name() === 'mcp' && (name === 'conformance' || name === 'scan')
    ? ['mcp', name]
    : undefined;
}

/** The arguments the program was given (commander keeps them as `rawArgs`, which its types leave out). */
export const rawArgsOf = (program: object): readonly string[] =>
  (program as { rawArgs?: string[] }).rawArgs ?? [];
