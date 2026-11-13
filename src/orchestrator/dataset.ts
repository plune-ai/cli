// Dataset loading (dirty edge). A DatasetRef is either a JSONL file path (relative to the config's
// base dir) or an inline { examples }. One JSON object per non-blank line.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatasetRef, DatasetRow } from '../types/config.js';
import { RunConfigError } from './run.js';

export function loadDataset(ref: DatasetRef, baseDir: string): DatasetRow[] {
  if (typeof ref !== 'string') {
    return ref.examples;
  }
  const file = path.resolve(baseDir, ref);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // A file the config names is the user's to fix (#256): a config error, as a missing prompt_file is,
    // not the raw file-system error that the top-level handler reports as an internal one.
    throw new RunConfigError(
      (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${ref}: dataset file not found (looked for ${file})`
        : `${ref}: cannot read the dataset file (${(err as Error).message})`,
    );
  }
  const rows: DatasetRow[] = [];
  content.split(/\r?\n/).forEach((line, i) => {
    if (line.trim().length === 0) return;
    let row: unknown;
    try {
      // trim() also drops a UTF-8 BOM (U+FEFF), which Notepad and PowerShell write.
      row = JSON.parse(line.trim());
    } catch (err) {
      throw new RunConfigError(`${ref}:${i + 1}: not valid JSON (${(err as Error).message})`);
    }
    // Only the shape that would otherwise crash the run is checked: an object with a `vars` object.
    // Anything looser that loads today (`expected` not a string, `vars` values null or arrays) still
    // passes, and the row is returned as parsed, so what a valid file gives the run is unchanged.
    const vars = isObject(row) ? row['vars'] : undefined;
    if (!isObject(vars)) {
      const why =
        isObject(row) && 'vars' in row
          ? `vars: Invalid input: expected record, received ${typeName(vars)}`
          : 'this row has no "vars"';
      throw new RunConfigError(
        `${ref}:${i + 1}: a dataset row must be { "vars": { ... } }; ${why}`,
      );
    }
    rows.push(row as DatasetRow);
  });
  return rows;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}
