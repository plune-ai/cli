import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDataset } from '../dataset.js';
import { RunConfigError } from '../run.js';
import type { DatasetRow } from '../../types/config.js';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plune-ds-'));
}

describe('loadDataset', () => {
  it('reads a JSONL file (relative to baseDir) into rows', () => {
    const dir = tmpDir();
    fs.writeFileSync(
      path.join(dir, 'data.jsonl'),
      '{"vars":{"a":1}}\n{"vars":{"a":2},"expected":"x"}\n',
    );
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

  // plune-ai/plune#2543: a row without `vars` crashed the run with an internal error.
  it('a row without "vars" is a config error naming the file and line', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'd.jsonl'), '{"vars":{"q":"ok"}}\n\n{"q":"hi"}\n');
    expect(() => loadDataset('d.jsonl', dir)).toThrow(RunConfigError);
    expect(() => loadDataset('d.jsonl', dir)).toThrow(
      'd.jsonl:3: a dataset row must be { "vars": { ... } }; this row has no "vars"',
    );
  });

  it('a row whose "vars" is not an object is the same config error', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'd.jsonl'), '{"vars":"x"}\n');
    expect(() => loadDataset('d.jsonl', dir)).toThrow(RunConfigError);
    expect(() => loadDataset('d.jsonl', dir)).toThrow(
      /^d\.jsonl:1: a dataset row must be \{ "vars": \{ \.\.\. \} \}; vars: /,
    );
  });

  it('names what "vars" is when it is null, an array or a scalar', () => {
    const dir = tmpDir();
    const cases: [string, string][] = [
      ['{"vars":null}', 'received null'],
      ['{"vars":[1,2]}', 'received array'],
      ['{"vars":7}', 'received number'],
    ];
    for (const [line, received] of cases) {
      fs.writeFileSync(path.join(dir, 'd.jsonl'), `${line}\n`);
      expect(() => loadDataset('d.jsonl', dir)).toThrow(
        `d.jsonl:1: a dataset row must be { "vars": { ... } }; vars: Invalid input: expected record, ${received}`,
      );
    }
  });

  it('a line that parses to something other than an object has no "vars"', () => {
    const dir = tmpDir();
    for (const line of ['[1,2]', '"text"', '42', 'null']) {
      fs.writeFileSync(path.join(dir, 'd.jsonl'), `${line}\n`);
      expect(() => loadDataset('d.jsonl', dir)).toThrow(
        'd.jsonl:1: a dataset row must be { "vars": { ... } }; this row has no "vars"',
      );
    }
  });

  it('a line that is not valid JSON is a config error naming the file and line', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'd.jsonl'), '{"vars":{}}\n\n{"vars":{"q":"hi"}\n');
    expect(() => loadDataset('d.jsonl', dir)).toThrow(RunConfigError);
    expect(() => loadDataset('d.jsonl', dir)).toThrow(/^d\.jsonl:3: not valid JSON \(.+\)$/);
  });

  it('reads a file with a UTF-8 BOM and CRLF line ends', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'd.jsonl'), '﻿{"vars":{"a":1}}\r\n{"vars":{"a":2}}\r\n');
    expect(loadDataset('d.jsonl', dir)).toEqual([{ vars: { a: 1 } }, { vars: { a: 2 } }]);
  });

  it('keeps loosely typed rows that load today', () => {
    const dir = tmpDir();
    const lines = [
      '{"vars":{"q":"hi"},"expected":5}',
      '{"vars":{"q":"hi"},"expected":null}',
      '{"vars":{"q":null}}',
      '{"vars":{"q":["a","b"]}}',
    ];
    fs.writeFileSync(path.join(dir, 'd.jsonl'), lines.join('\n'));
    expect(loadDataset('d.jsonl', dir)).toEqual(lines.map((l) => JSON.parse(l) as unknown));
  });

  it('valid rows come back exactly as written, unknown keys included', () => {
    const dir = tmpDir();
    const lines = ['{"vars":{"q":"hi","n":2,"b":true},"expected":"x","id":"r1"}', '{"vars":{}}'];
    fs.writeFileSync(path.join(dir, 'd.jsonl'), lines.join('\n'));
    expect(loadDataset('d.jsonl', dir)).toEqual(lines.map((l) => JSON.parse(l) as unknown));
  });
});
