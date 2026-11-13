import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseToolDescriptions } from '../run.js';
import { RunConfigError } from '../../../orchestrator/index.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-desc-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('CLI · run · tool-description · the flag', () => {
  it('CLI · run · tool-description · <tool>=<text> keeps everything after the first =, and several tools are allowed', () => {
    expect(parseToolDescriptions(['search=Find a=b thing', 'list=Lists'])).toEqual({
      search: 'Find a=b thing',
      list: 'Lists',
    });
  });

  it('CLI · run · tool-description · <tool>=@<file> reads the file, without its last line break', () => {
    const file = path.join(tmp, 'new.txt');
    fs.writeFileSync(file, 'Find an issue by words\r\n');
    expect(parseToolDescriptions([`search=@${file}`])).toEqual({
      search: 'Find an issue by words',
    });
  });

  it('CLI · run · tool-description · a malformed, duplicate, missing or empty one is a config error', () => {
    for (const bad of [
      ['search'],
      ['=text'],
      ['search='],
      ['a=1', 'a=2'],
      [`search=@${path.join(tmp, 'nope.txt')}`],
    ])
      expect(() => parseToolDescriptions(bad), bad.join(' ')).toThrow(RunConfigError);
    const empty = path.join(tmp, 'empty.txt');
    fs.writeFileSync(empty, '\n');
    expect(() => parseToolDescriptions([`search=@${empty}`])).toThrow(RunConfigError);
  });
});
