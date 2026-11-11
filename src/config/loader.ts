import * as fs from 'node:fs/promises';
import { parse } from 'yaml';
import { applyEnvOverrides } from './env-overrides.js';
import { ConfigNotFoundError, ConfigValidationError, YamlParseError } from './errors.js';
import { discoverConfigPath } from './discover.js';
import { mcpVariableIssues } from './mcp.js';
import { pluneConfigSchema } from './schema.js';
import type { Config } from '../types/config.js';

interface LoadConfigOptions {
  configPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<Config> {
  const { configPath, cwd = process.cwd(), env = process.env } = opts;

  const resolvedPath = discoverConfigPath(cwd, configPath);

  let raw: string;
  try {
    raw = await fs.readFile(resolvedPath, 'utf8');
  } catch {
    throw new ConfigNotFoundError(`Cannot read config file: ${resolvedPath}`);
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    throw new YamlParseError(
      `YAML parse error in ${resolvedPath}: ${(err as Error).message}`,
    );
  }

  const result = pluneConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigValidationError(
      `Config validation failed in ${resolvedPath}`,
      issues,
    );
  }

  const config = result.data as unknown as Config;
  // `${VAR}` is checked here and filled only when a server is reached, so the config (and its hash) keeps it as written.
  const unset = mcpVariableIssues(config, env);
  if (unset.length > 0)
    throw new ConfigValidationError(`Config validation failed in ${resolvedPath}`, unset);

  return applyEnvOverrides(config, env);
}
