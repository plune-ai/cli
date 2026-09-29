// Dirty edge: read a `.env` into the environment before a command runs (CLI_SPEC §2). Which
// directories, and in what order, is the program's rule (the preAction hook in cli.ts) — this is
// only the loader. Pure core never reads process.env directly for secrets — the CLI enriches the
// environment here, then the provider layer reads keys from it (FR-7).

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';

/**
 * Load `<dir>/.env` into `process.env`.
 *
 * - Variables already present in `process.env` are NOT overwritten (`override: false`) —
 *   an explicit shell export always wins over the file (AC-T02.2), and so does a variable an
 *   earlier `loadEnv` already set: the first directory loaded wins where two files disagree.
 * - A missing `.env` is silently ignored — dotenv reports it via `result.error`, never throws
 *   (AC-T02.3).
 * - Key *values* are never logged here; we only mutate the environment (NFR-2).
 */
export function loadEnv(dir: string): void {
  dotenvConfig({ path: path.join(dir, '.env'), override: false });
}
