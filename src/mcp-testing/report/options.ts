/**
 * The report flags of every `plune mcp` command that tests a server: `--format`, `--reporter` and the repeatable
 * `--out`. Commander and the usage error only, so the command line can register them without loading a renderer.
 */

import type { Command } from 'commander';
import { UsageError } from '../connect/options.js';

export const STDOUT_FORMATS = ['human', 'json', 'github', 'markdown'] as const;
export const FILE_FORMATS = ['json', 'junit-xml', 'markdown'] as const;
export const REPORTERS = ['junit-xml'] as const;
export type StdoutFormat = (typeof STDOUT_FORMATS)[number];
export type FileFormat = (typeof FILE_FORMATS)[number];
export type ReportFormat = StdoutFormat | FileFormat;

export interface ReportFlags {
  format?: string;
  reporter?: string;
  /** Repeatable; a string from a caller that passes one. */
  out?: string | string[];
}

const collect = (value: string, previous: string[] | undefined) => [...(previous ?? []), value];

/** `--format`, `--reporter` and the repeatable `--out`, the same on every command. */
export function addReportOptions(cmd: Command): Command {
  return cmd
    .option(
      '--format <format>',
      'What to print: human, json, github (annotations for a GitHub Actions step) or markdown (a pull request comment)',
      'human',
    )
    .option(
      '--reporter <reporter>',
      'junit-xml: a bare --out <path> is written as JUnit XML instead of JSON',
    )
    .option(
      '--out <[format=]path>',
      `Also write the report to this file, as ${FILE_FORMATS.join(', ')} (default json); repeatable, one run for every file. No URL, command, environment or header in it, secrets masked`,
      collect,
    );
}

export interface ReportOutputs {
  format: StdoutFormat;
  files: { format: FileFormat; path: string }[];
}

function oneOf<T extends string>(flag: string, value: string, allowed: readonly T[]): T {
  if (!(allowed as readonly string[]).includes(value))
    throw new UsageError(`${flag} must be one of ${allowed.join(', ')} (got "${value}").`);
  return value as T;
}

/**
 * What the flags ask for, read before anything connects: a wrong value is exit 2 with the values allowed. A bare
 * `--out <path>` is JSON, or JUnit with `--reporter junit-xml`; `<format>=<path>` names its format, and a word before
 * `=` that is not one of them is refused rather than taken as part of a file name.
 */
export function reportOutputs(flags: ReportFlags): ReportOutputs {
  const format = oneOf('--format', flags.format ?? 'human', STDOUT_FORMATS);
  const reporter =
    flags.reporter === undefined ? undefined : oneOf('--reporter', flags.reporter, REPORTERS);
  const outs = flags.out === undefined ? [] : [flags.out].flat();
  if (reporter !== undefined && outs.length === 0)
    throw new UsageError(`--reporter ${reporter} writes a file: give it --out <path>.`);
  const files = outs.map((raw) => {
    const named = /^([a-z][a-z0-9-]*)=(.*)$/s.exec(raw);
    const fileFormat =
      named === null ? (reporter ?? 'json') : oneOf('--out', named[1] ?? '', FILE_FORMATS);
    const path = named === null ? raw : (named[2] ?? '');
    if (path === '') throw new UsageError(`--out ${raw}: the file name is missing.`);
    return { format: fileFormat, path };
  });
  return { format, files };
}
