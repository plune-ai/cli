// `plune init` orchestration (T03). Composes the interactive wizard (which writes plune.yaml)
// with static template scaffolding (an example dataset + .env.example). Dirty edge: all fs writes
// happen here and in the template helper; nothing here is pure-core logic.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'yaml';
import { runInitWizard } from '../../config/init/wizard.js';
import {
  writeTemplateFile,
  EXAMPLE_JSONL_TPL,
  ENV_EXAMPLE_TPL,
  PLUNE_YAML_TPL,
  PROVIDER_KEY_VARS,
} from '../templates/index.js';

export interface InitOptions {
  cwd: string;
  /** Overwrite existing template files instead of skipping them (AC-T03.3). */
  force: boolean;
  /** Non-interactive: skip the wizard and scaffold a default plune.yaml (works in CI / non-TTY). */
  yes?: boolean;
}

// Template files scaffolded after plune.yaml. In the interactive flow plune.yaml is the wizard's
// job; with --yes it is scaffolded from PLUNE_YAML_TPL too. These two are always static.
const TEMPLATES: ReadonlyArray<readonly [string, string]> = [
  ['datasets/example.jsonl', EXAMPLE_JSONL_TPL],
  ['.env.example', ENV_EXAMPLE_TPL],
];

function reportWrite(cwd: string, rel: string, content: string, force: boolean): void {
  const status = writeTemplateFile(cwd, rel, content, force);
  process.stdout.write(
    status === 'skipped'
      ? `Skipped existing ${rel} (use --force to overwrite).\n`
      : `Created ${rel}.\n`,
  );
}

/**
 * What to do with the files that were just written.
 *
 * `init` used to end at "Created .env.example." and stop — technically complete, and a dead
 * end for anyone who does not already know the next command. Three steps, in the order they happen.
 *
 * The FIRST line is the important one, and it is a boundary rather than a nicety: `plune run`
 * needs no account, no platform token and no network beyond the model provider, but it
 * does need that provider's key (or the built-in mock), so the line says so (#246). Leading with the
 * platform would make the product look like it requires a sign-up it does not.
 */
export function nextSteps(keyVar?: string): string {
  const key = keyVar === undefined ? "your provider's key" : keyVar;
  return [
    '',
    'Next:',
    '  1. plune run     — runs locally: no account or platform token needed. It calls the model,',
    `                     so put ${key} in .env (copy .env.example).`,
    '                     With no key yet, PLUNE_MOCK_PROVIDER=1 plune run uses a built-in stand-in',
    '                     model: it checks the setup, and its answers fail the example.',
    '  2. plune login   — only if you want history and trends: paste a token from the dashboard.',
    '  3. plune sync    — sends the last run to the platform.',
    '',
  ].join('\n');
}

/** The key variable of the provider written in `<cwd>/plune.yaml`, or undefined when it cannot be told. */
function keyVarOf(cwd: string): string | undefined {
  try {
    const cfg = parse(fs.readFileSync(path.join(cwd, 'plune.yaml'), 'utf8')) as {
      provider?: { type?: unknown };
    } | null;
    const type = cfg?.provider?.type;
    return typeof type === 'string' && Object.hasOwn(PROVIDER_KEY_VARS, type)
      ? PROVIDER_KEY_VARS[type]
      : undefined;
  } catch {
    return undefined;
  }
}

export interface InitFromOpenAiEvalOptions {
  cwd: string;
  force: boolean;
  /** The exported eval object (JSON). */
  evalPath: string;
  /** One run of the eval (JSON): the prompt template and the model. */
  runPath?: string;
  /** The test data (JSONL). */
  dataPath?: string;
}

/**
 * `plune init --from-openai-eval`: read the exported files, convert, then write. Everything is read and
 * converted before the first write, so a file that is not what it should be leaves the folder untouched.
 * Throws `OpenAiEvalImportError` for input the person can fix (the CLI maps it to exit 2).
 */
export async function initFromOpenAiEval(options: InitFromOpenAiEvalOptions): Promise<void> {
  const { cwd, force } = options;
  const { convertOpenAiEval, formatReport, OpenAiEvalImportError } =
    await import('../../config/init/from-openai-eval.js');
  const read = (file: string): string => {
    try {
      return fs.readFileSync(path.resolve(cwd, file), 'utf8');
    } catch (err) {
      throw new OpenAiEvalImportError(`cannot read ${file}: ${(err as Error).message}`);
    }
  };
  const json = (file: string): unknown => {
    try {
      return JSON.parse(read(file));
    } catch (err) {
      if (err instanceof OpenAiEvalImportError) throw err;
      throw new OpenAiEvalImportError(`${file} is not JSON`);
    }
  };
  const converted = convertOpenAiEval({
    evalObject: json(options.evalPath),
    ...(options.runPath !== undefined ? { run: json(options.runPath) } : {}),
    ...(options.dataPath !== undefined ? { rows: read(options.dataPath) } : {}),
  });

  reportWrite(cwd, 'plune.yaml', converted.yaml, force);
  if (converted.dataset) reportWrite(cwd, converted.dataset.path, converted.dataset.jsonl, force);
  reportWrite(cwd, '.env.example', ENV_EXAMPLE_TPL, force);
  process.stdout.write('\n' + formatReport(converted.report));
  process.stdout.write(nextSteps(keyVarOf(cwd)));
}

/**
 * Run the init flow. With `yes`, scaffold a default `plune.yaml` non-interactively (no prompts,
 * no TTY needed); otherwise run the interactive wizard (which throws `NonTtyError` in a non-TTY,
 * mapped by the CLI to exit 1, AC-T03.6). Either way, scaffold the example dataset and
 * `.env.example`, skipping existing files unless `force` is set.
 */
export async function initCommand({ cwd, force, yes = false }: InitOptions): Promise<void> {
  if (yes) {
    reportWrite(cwd, 'plune.yaml', PLUNE_YAML_TPL, force);
  } else {
    await runInitWizard(cwd);
  }
  for (const [rel, content] of TEMPLATES) {
    reportWrite(cwd, rel, content, force);
  }
  // After the file lines, in both flows: the wizard's own outro is about plune.yaml and fires
  // before these two files exist.
  process.stdout.write(nextSteps(keyVarOf(cwd)));
}
