// Dataset loading (dirty edge). A DatasetRef is either a JSONL file path (relative to the config's
// base dir) or an inline { examples }. One JSON object per non-blank line.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatasetRef, DatasetRow } from '../types/config.js';

export function loadDataset(ref: DatasetRef, baseDir: string): DatasetRow[] {
  if (typeof ref !== 'string') {
    return ref.examples;
  }
  const content = fs.readFileSync(path.resolve(baseDir, ref), 'utf8');
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as DatasetRow);
}
