import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig } from '../loader.js';
import { ConfigNotFoundError, ConfigValidationError, YamlParseError } from '../errors.js';
import type { Config } from '../../types/config.js';

const VALID_YAML = `
version: 1
provider:
  type: anthropic
  model: claude-3-opus
evals:
  - id: test-eval
    prompt: "Hello"
    dataset: data/test.jsonl
    assertions:
      - type: contains
        value: "world"
`.trimStart();

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-loader-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('parses a valid YAML file and returns a typed Config', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, VALID_YAML);

    const result = await loadConfig({ configPath });

    expect(result.version).toBe(1);
    expect(result.provider.type).toBe('anthropic');
    expect(result.provider.model).toBe('claude-3-opus');
    expect(result.evals).toHaveLength(1);
    expect(result.evals[0]?.id).toBe('test-eval');

    // Confirm the return is assignable to Config (type-level)
    const _typed: Config = result;
    void _typed;
  });

  it('throws ConfigValidationError with all issues when YAML has multiple validation errors', async () => {
    const badYaml = `
version: 1
provider:
  type: unknown-provider
  model: ""
evals:
  - prompt: "no-id"
    dataset: data.jsonl
    assertions: []
`.trimStart();
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, badYaml);

    try {
      await loadConfig({ configPath });
      expect.fail('should have thrown ConfigValidationError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      const e = err as ConfigValidationError;
      expect(e.code).toBe('CONFIG_VALIDATION_ERROR');
      // Both provider.type and evals[0].id errors must be reported together
      expect(e.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('throws YamlParseError on invalid YAML syntax', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, 'version: 1\n  bad: [invalid: yaml');

    try {
      await loadConfig({ configPath });
      expect.fail('should have thrown YamlParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(YamlParseError);
      expect((err as YamlParseError).code).toBe('YAML_PARSE_ERROR');
    }
  });

  it('throws ConfigNotFoundError when configPath does not exist', async () => {
    const missing = path.join(tmpDir, 'nonexistent.yaml');
    await expect(loadConfig({ configPath: missing })).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('throws ConfigNotFoundError when the resolved path cannot be read (e.g. a directory)', async () => {
    // tmpDir exists, so discover returns it; reading a directory throws EISDIR → the readFile
    // catch branch (loader.ts) maps it to ConfigNotFoundError.
    await expect(loadConfig({ configPath: tmpDir })).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it('discovers plune.yaml via traversal when no configPath is given', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, VALID_YAML);
    const subDir = path.join(tmpDir, 'src');
    fs.mkdirSync(subDir, { recursive: true });

    const result = await loadConfig({ cwd: subDir });

    expect(result.version).toBe(1);
    expect(result.provider.type).toBe('anthropic');
  });

  it('applies env var overrides to the parsed config', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, VALID_YAML);

    const result = await loadConfig({
      configPath,
      env: { PLUNE_MODEL: 'claude-3-sonnet', PLUNE_TIMEOUT: '5000' },
    });

    expect(result.provider.model).toBe('claude-3-sonnet');
    expect(result.provider.timeout).toBe(5000);
    expect(result.provider.type).toBe('anthropic'); // unchanged
  });
});
