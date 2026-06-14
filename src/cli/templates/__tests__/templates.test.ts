import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeTemplateFile,
  EXAMPLE_JSONL_TPL,
  ENV_EXAMPLE_TPL,
  PLUNE_YAML_TPL,
} from '../index.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-tpl-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('writeTemplateFile', () => {
  it('writes a new file (creating parent dirs) and returns "written" (AC-T03.1)', () => {
    const result = writeTemplateFile(tmp, 'datasets/example.jsonl', EXAMPLE_JSONL_TPL, false);
    expect(result).toBe('written');
    expect(fs.existsSync(path.join(tmp, 'datasets', 'example.jsonl'))).toBe(true);
  });

  it('skips an existing file when force=false and preserves it (AC-T03.2)', () => {
    const rel = '.env.example';
    fs.writeFileSync(path.join(tmp, rel), 'OLD CONTENT');
    const result = writeTemplateFile(tmp, rel, ENV_EXAMPLE_TPL, false);
    expect(result).toBe('skipped');
    expect(fs.readFileSync(path.join(tmp, rel), 'utf8')).toBe('OLD CONTENT');
  });

  it('overwrites an existing file when force=true (AC-T03.3)', () => {
    const rel = '.env.example';
    fs.writeFileSync(path.join(tmp, rel), 'OLD CONTENT');
    const result = writeTemplateFile(tmp, rel, ENV_EXAMPLE_TPL, true);
    expect(result).toBe('written');
    expect(fs.readFileSync(path.join(tmp, rel), 'utf8')).toBe(ENV_EXAMPLE_TPL);
  });
});

describe('template content', () => {
  it('.env.example holds only placeholders, never a real key (AC-T03.4, NFR-5)', () => {
    expect(ENV_EXAMPLE_TPL).toContain('YOUR_ANTHROPIC_API_KEY_HERE');
    // No real-looking secret values (e.g. an OpenAI/Anthropic key).
    expect(ENV_EXAMPLE_TPL).not.toMatch(/sk-[a-zA-Z0-9]{16,}/);
  });

  it('example.jsonl has 2+ rows, each valid JSON with a `vars` object', () => {
    const lines = EXAMPLE_JSONL_TPL.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      const row = JSON.parse(line) as { vars?: unknown };
      expect(typeof row.vars).toBe('object');
    }
  });

  it('default plune.yaml is commented, valid, and points at the example dataset (T009b)', () => {
    expect(PLUNE_YAML_TPL).toMatch(/^#/m); // explanatory comments
    expect(PLUNE_YAML_TPL).toContain('version: 1');
    expect(PLUNE_YAML_TPL).toContain('provider:');
    expect(PLUNE_YAML_TPL).toContain('datasets/example.jsonl');
  });
});
