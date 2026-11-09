// Dataset loading (dirty edge). A DatasetRef is either a JSONL file path (relative to the config's
// base dir) or an inline { examples }. One JSON object per non-blank line.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { datasetRowSchema } from '../config/schema.js';
import type { DatasetRef, DatasetRow } from '../types/config.js';
import { RunConfigError } from './run.js';

export function loadDataset(ref: DatasetRef, baseDir: string): DatasetRow[] {
  if (typeof ref !== 'string') {
    return ref.examples;
  }
  const content = fs.readFileSync(path.resolve(baseDir, ref), 'utf8');
  const rows: DatasetRow[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    if (line.trim().length === 0) return;
    const row: unknown = JSON.parse(line);
    // Each file row is held to the shape inline `examples:` rows are. The row itself is returned,
    // not zod's copy, so what a valid file gives the run is unchanged.
    const checked = datasetRowSchema.safeParse(row);
    if (!checked.success) {
      const hasVars = typeof row === 'object' && row !== null && 'vars' in row;
      const issue = checked.error.issues[0];
      const why = hasVars
        ? `${issue?.path.join('.') ?? ''}: ${issue?.message ?? 'invalid'}`
        : 'this row has no "vars"';
      throw new RunConfigError(
        `${ref}:${i + 1}: a dataset row must be { "vars": { ... } }; ${why}`,
      );
    }
    rows.push(row as DatasetRow);
  });
  return rows;
}
