import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDataset } from '../dataset.js';
import type { DatasetRow } from '../../types/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plune-ds-'));
}

describe('loadDataset', () => {
  it('reads a JSONL file (relative to baseDir) into rows', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'data.jsonl'), '{"vars":{"a":1}}\n{"vars":{"a":2},"expected":"x"}\n');
    const rows = loadDataset('data.jsonl', dir);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.vars).toEqual({ a: 1 });
    expect(rows[1]!.expected).toBe('x');
  });

  it('passes through inline examples', () => {
    const examples: DatasetRow[] = [{ vars: { a: 1 } }, { vars: { b: 2 }, expected: 'y' }];
    expect(loadDataset({ examples }, '/base')).toEqual(examples);
  });

  it('ignores blank lines', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'd.jsonl'), '{"vars":{}}\n\n  \n{"vars":{}}\n');
    expect(loadDataset('d.jsonl', dir)).toHaveLength(2);
  });
});
