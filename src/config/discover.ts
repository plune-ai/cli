import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigNotFoundError } from './errors.js';

const FILENAME = 'plune.yaml';
const MAX_STEPS = 50;

export function discoverConfigPath(cwd: string, override?: string): string {
  if (override !== undefined) {
    if (fs.existsSync(override)) {
      return override;
    }
    throw new ConfigNotFoundError(`Config file not found: ${override}`);
  }

  let dir = cwd;
  let steps = 0;

  while (steps < MAX_STEPS) {
    const candidate = path.join(dir, FILENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }

    dir = parent;
    steps++;
  }

  throw new ConfigNotFoundError(
    `No ${FILENAME} found. Run "plune init" to create one.`,
  );
}
