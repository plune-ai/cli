// Dirty edge: auto-load a `.env` next to the config file before a command runs (CLI_SPEC §2).
// Pure core never reads process.env directly for secrets — the CLI enriches the environment here,
// then the provider layer reads keys from it (FR-7).

import { config as dotenvConfig } from 'dotenv';
import * as path from 'node:path';

/**
 * Load `<configDir>/.env` into `process.env`.
 *
 * - Variables already present in `process.env` are NOT overwritten (`override: false`) —
 *   an explicit shell export always wins over the file (AC-T02.2).
 * - A missing `.env` is silently ignored — dotenv reports it via `result.error`, never throws
 *   (AC-T02.3).
 * - Key *values* are never logged here; we only mutate the environment (NFR-2).
 */
export function loadEnv(configDir: string): void {
  dotenvConfig({ path: path.join(configDir, '.env'), override: false });
}
