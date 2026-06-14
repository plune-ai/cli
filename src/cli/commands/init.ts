// `plune init` orchestration (T03). Composes the interactive wizard (which writes plune.yaml)
// with static template scaffolding (an example dataset + .env.example). Dirty edge: all fs writes
// happen here and in the template helper; nothing here is pure-core logic.

import { runInitWizard } from '../../config/init/wizard.js';
import {
  writeTemplateFile,
  EXAMPLE_JSONL_TPL,
  ENV_EXAMPLE_TPL,
  PLUNE_YAML_TPL,
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
}
