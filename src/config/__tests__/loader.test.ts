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

  // A Node timer cannot wait longer than 2147483647 ms: past it, the SDK's timeout fires after about 1 ms and
  // every model call times out at once. Both sources of the timeout are refused with the field named.
  const withTimeout = (t: string): string =>
    VALID_YAML.replace('  model: claude-3-opus\n', `  model: claude-3-opus\n  timeout: ${t}\n`);
  const issuesOf = async (p: Promise<unknown>): Promise<string[]> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigValidationError);
    return (err as ConfigValidationError).issues;
  };
  const reason = (issue: string | undefined): string =>
    (issue ?? '').slice((issue ?? '').indexOf(': ') + 2);

  it('refuses a provider timeout above 2147483647 ms in plune.yaml, naming the field', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, withTimeout('3000000000'));
    const issues = await issuesOf(loadConfig({ configPath, env: {} }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/^provider\.timeout: .*2147483647 ms/);
  });

  it('refuses an eval provider timeout above 2147483647 ms', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(
      configPath,
      VALID_YAML.replace(
        '    prompt: "Hello"\n',
        '    prompt: "Hello"\n    provider:\n      timeout: 2147483648\n',
      ),
    );
    const issues = await issuesOf(loadConfig({ configPath, env: {} }));
    expect(issues[0]).toMatch(/^evals\.0\.provider\.timeout: .*2147483647 ms/);
  });

  it('accepts a timeout of exactly 2147483647 ms from plune.yaml and from PLUNE_TIMEOUT', async () => {
    const configPath = path.join(tmpDir, 'plune.yaml');
    fs.writeFileSync(configPath, withTimeout('2147483647'));
    expect((await loadConfig({ configPath, env: {} })).provider.timeout).toBe(2147483647);
    fs.writeFileSync(configPath, VALID_YAML);
    const fromEnv = await loadConfig({ configPath, env: { PLUNE_TIMEOUT: '2147483647' } });
    expect(fromEnv.provider.timeout).toBe(2147483647);
  });

  it.each(['3000000000', '0', '-5', '1.5'])(
    'refuses PLUNE_TIMEOUT=%s with the variable named, for the reason the same value in plune.yaml is refused',
    async (v) => {
      const configPath = path.join(tmpDir, 'plune.yaml');
      fs.writeFileSync(configPath, VALID_YAML);
      const issues = await issuesOf(loadConfig({ configPath, env: { PLUNE_TIMEOUT: v } }));
      expect(issues).toHaveLength(1);
      expect(issues[0]?.startsWith(`PLUNE_TIMEOUT=${v}: `)).toBe(true);
      fs.writeFileSync(configPath, withTimeout(v));
      const yamlIssues = await issuesOf(loadConfig({ configPath, env: {} }));
      expect(reason(issues[0])).toBe(reason(yamlIssues[0]));
    },
  );
});
