import { Command } from 'commander';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReportFormat } from './reporters/index.js';

// COLD-START (NFR-1, <300ms): keep this module's top-level imports tiny — commander + node
// builtins only. The command handlers transitively load heavy deps (@huggingface/transformers,
// better-sqlite3, provider SDKs), so they are dynamically imported INSIDE each action. That way
// `plune --version` / `--help` / an unknown command never pay for them.

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string;
};

function toFormat(s: string): ReportFormat {
  return s === 'json' || s === 'markdown' ? s : 'console';
}

function shouldColor(outputPath: string | undefined): boolean {
  return (
    outputPath === undefined && process.stdout.isTTY === true && process.env.NO_COLOR === undefined
  );
}

function writeReport(text: string, outputPath: string | undefined): void {
  if (outputPath !== undefined) {
    writeFileSync(outputPath, text);
  } else {
    process.stdout.write(text + '\n');
  }
}

// Stack traces are opt-in via --verbose (constitution §5: "fail loud, exit clean" — a clean
// message by default, the stack only when the user asks for it). `maybeStack` appends the stack
// after an already-printed message (used by the exit-2 config paths); `failUnexpected` handles an
// unclassified error: message-or-stack, then exit 1.
function maybeStack(err: unknown, verbose: boolean): void {
  if (verbose && err instanceof Error && err.stack !== undefined) {
    process.stderr.write(err.stack + '\n');
  }
}

function failUnexpected(err: unknown, verbose: boolean): void {
  if (err instanceof Error) {
    process.stderr.write((verbose && err.stack !== undefined ? err.stack : err.message) + '\n');
  } else {
    process.stderr.write(String(err) + '\n');
  }
  process.exit(1);
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name('plune')
    .description('Plune — AI-powered assertion testing CLI')
    .version(pkg.version);

  // Global flags (ADR-S10-01): defined on the root program so every subcommand can read them
  // via `command.optsWithGlobals()`. `--no-color` is parsed by commander as `color: false`.
  program
    .option('-c, --config <path>', 'Path to plune.yaml config file (applies to all commands)')
    .option('-v, --verbose', 'Verbose output, including stack traces on unexpected errors', false)
    .option('--no-color', 'Disable colored output regardless of TTY');

  program
    .command('run')
    .description('Run assertions against a dataset')
    .option('--dry-run', 'Estimate cost/tokens; do not call the model', false)
    .option('--config <path>', 'Path to plune.yaml config file')
    .option(
      '--only <selector>',
      'Run a subset by eval id or tag (repeatable)',
      (val: string, prev: string[]) => [...prev, val],
      [] as string[],
    )
    .option('--concurrency <n>', 'Override provider concurrency', (v: string) => parseInt(v, 10))
    .option('--no-cache', 'Bypass the local cache for this run')
    .option('--bail', 'Stop after the first failing eval', false)
    .option('--format <fmt>', 'console | json | markdown', 'console')
    .option('-o, --output <path>', 'Write the report to a file instead of stdout')
    .action(
      async (
        options: {
          dryRun: boolean;
          config?: string;
          only: string[];
          concurrency?: number;
          cache: boolean;
          bail: boolean;
          format: string;
          output?: string;
        },
        command: Command,
      ) => {
        // optsWithGlobals() merges this command's local options with the program's global ones
        // (-c/--config, --verbose, --no-color). Local --config (back-compat) wins over global -c.
        const globals = command.optsWithGlobals() as {
          config?: string;
          verbose?: boolean;
          color?: boolean;
        };
        const configPath = globals.config;
        // Lazy-load the heavy run pipeline only now that `run` is actually executing.
        const [
          { loadEnv },
          { handleRun },
          { exitCodeFor, RunConfigError },
          { renderReport },
          { ConfigNotFoundError, ConfigValidationError, YamlParseError },
          { AuthError },
        ] = await Promise.all([
          import('./cli/env.js'),
          import('./cli/commands/run.js'),
          import('./orchestrator/index.js'),
          import('./reporters/index.js'),
          import('./config/errors.js'),
          import('./providers/errors.js'),
        ]);
        // Auto-load `.env` from the config's directory before the provider reads any API key
        // (ADR-S10-02). Never overrides an already-exported variable; missing file is ignored.
        loadEnv(configPath !== undefined ? dirname(resolve(configPath)) : process.cwd());
        try {
          const result = await handleRun({
            dryRun: options.dryRun,
            ...(configPath !== undefined ? { configPath } : {}),
            ...(options.only.length > 0 ? { only: options.only } : {}),
            ...(typeof options.concurrency === 'number' && Number.isFinite(options.concurrency)
              ? { concurrency: options.concurrency }
              : {}),
            noCache: options.cache === false,
            bail: options.bail,
          });
          if (options.only.length > 0 && result.evals.length === 0) {
            process.stderr.write('No evals matched the selector.\n');
          }
          const text = renderReport(result, toFormat(options.format), {
            color: globals.color !== false && shouldColor(options.output),
          });
          writeReport(text, options.output);
          process.exitCode = exitCodeFor(result);
        } catch (err) {
          const verbose = globals.verbose === true;
          if (err instanceof ConfigValidationError) {
            process.stderr.write(err.message + '\n');
            for (const issue of err.issues) {
              process.stderr.write(`  - ${issue}\n`);
            }
            maybeStack(err, verbose);
            process.exit(2);
            return;
          }
          if (err instanceof ConfigNotFoundError || err instanceof YamlParseError) {
            process.stderr.write((err as Error).message + '\n');
            maybeStack(err, verbose);
            process.exit(2);
            return;
          }
          if (err instanceof AuthError) {
            // The message names the missing/invalid key's env var (FR-7); fail fast like config.
            process.stderr.write(err.message + '\n');
            maybeStack(err, verbose);
            process.exit(2);
            return;
          }
          if (err instanceof RunConfigError) {
            // Unknown prompt variable / missing prompt_file — a config error (CLI_SPEC §4.2 → 2).
            process.stderr.write(err.message + '\n');
            maybeStack(err, verbose);
            process.exit(2);
            return;
          }
          failUnexpected(err, verbose);
        }
      },
    );

  program
    .command('report')
    .description('Render the most recent run in a chosen format')
    .option('--format <fmt>', 'console | json | markdown', 'console')
    .option('-o, --output <path>', 'Write the report to a file instead of stdout')
    .action(async (options: { format: string; output?: string }, command: Command) => {
      const globals = command.optsWithGlobals() as {
        color?: boolean;
        config?: string;
        verbose?: boolean;
      };
      const [{ loadEnv }, { handleReport, ReportNotFoundError }, { renderReport }] =
        await Promise.all([
          import('./cli/env.js'),
          import('./cli/commands/report.js'),
          import('./reporters/index.js'),
        ]);
      // A global -c points report at the run saved beside that config (its .plune/), not cwd.
      const cwd = globals.config !== undefined ? dirname(resolve(globals.config)) : process.cwd();
      loadEnv(cwd);
      try {
        const result = handleReport({ cwd });
        const text = renderReport(result, toFormat(options.format), {
          color: globals.color !== false && shouldColor(options.output),
        });
        writeReport(text, options.output);
      } catch (err) {
        if (err instanceof ReportNotFoundError) {
          process.stderr.write(err.message + '\n');
          process.exit(2);
          return;
        }
        failUnexpected(err, globals.verbose === true);
      }
    });

  program
    .command('diff')
    .description('Compare two `plune run --format json` outputs and report regressions')
    .argument('<baseline>', 'Path to the baseline run JSON (e.g. from main)')
    .argument('<current>', 'Path to the current run JSON (e.g. from the PR)')
    .option('--format <fmt>', 'console | json | markdown', 'console')
    .option('--fail-on-regression', 'Exit 1 when a pass→fail regression is detected', false)
    .option('-o, --output <path>', 'Write the diff to a file instead of stdout')
    .action(
      async (
        baseline: string,
        current: string,
        options: { format: string; failOnRegression: boolean; output?: string },
        command: Command,
      ) => {
        const verbose = (command.optsWithGlobals() as { verbose?: boolean }).verbose === true;
        const [{ handleDiff, DiffInputError }, { renderDiff }] = await Promise.all([
          import('./cli/commands/diff.js'),
          import('./reporters/diff.js'),
        ]);
        try {
          const diff = handleDiff({ baselinePath: baseline, currentPath: current });
          writeReport(renderDiff(diff, toFormat(options.format)), options.output);
          // Regression gating is opt-in (AC-4): the diff is always reported; only
          // --fail-on-regression turns a pass→fail regression into a non-zero exit (→ 1, like a
          // failed run). Input errors take the exit-2 path below.
          process.exitCode = options.failOnRegression && diff.summary.hasRegression ? 1 : 0;
        } catch (err) {
          if (err instanceof DiffInputError) {
            process.stderr.write(err.message + '\n');
            maybeStack(err, verbose);
            process.exit(2);
            return;
          }
          failUnexpected(err, verbose);
        }
      },
    );

  program
    .command('init')
    .description('Scaffold plune.yaml (interactive), an example dataset, and .env.example')
    .option('--force', 'Overwrite existing files instead of skipping them', false)
    .option('--yes', 'Non-interactive: scaffold defaults without prompts (for CI)', false)
    .action(async (options: { force: boolean; yes: boolean }, command: Command) => {
      const verbose = (command.optsWithGlobals() as { verbose?: boolean }).verbose === true;
      const [{ initCommand }, { NonTtyError }] = await Promise.all([
        import('./cli/commands/init.js'),
        import('./config/errors.js'),
      ]);
      try {
        await initCommand({ cwd: process.cwd(), force: options.force, yes: options.yes });
      } catch (err) {
        if (err instanceof NonTtyError) {
          process.stderr.write((err as Error).message + '\n');
          process.exit(1);
          return;
        }
        failUnexpected(err, verbose);
      }
    });

  // Unknown command → exit 2 (CLI_SPEC §4.2). Registering a `command:*` listener makes commander
  // emit this event instead of its default "unknown command" error (which would exit 1).
  program.on('command:*', (operands: string[]) => {
    process.stderr.write(`Unknown command: ${operands.join(' ')}\n`);
    process.exit(2);
  });

  return program;
}

// Execute only when run as the main script, not when imported by tests. argv[1] may be a symlink:
// npm/npx install the bin as a symlink on Linux/macOS, so process.argv[1] is `.bin/plune` while
// import.meta.url resolves to the real dist/cli.cjs. A plain string compare mismatches and silently
// no-ops the entire CLI on Linux (exit 0, no output — issue #7). Compare realpaths so the guard
// fires on every platform; realpath is idempotent on the already-resolved module path.
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  createProgram()
    .parseAsync(process.argv)
    .catch((err: unknown) => {
      process.stderr.write(String(err) + '\n');
      process.exit(1);
    });
}
