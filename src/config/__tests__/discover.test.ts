import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverConfigPath } from '../discover.js';
import { ConfigNotFoundError } from '../errors.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-discover-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('discoverConfigPath', () => {
  describe('traversal', () => {
    it('finds plune.yaml in the start directory', () => {
      const configPath = path.join(tmpRoot, 'plune.yaml');
      fs.writeFileSync(configPath, 'version: 1');
      expect(discoverConfigPath(tmpRoot)).toBe(configPath);
    });

    it('finds plune.yaml in a parent directory', () => {
      const configPath = path.join(tmpRoot, 'plune.yaml');
      fs.writeFileSync(configPath, 'version: 1');
      const childDir = path.join(tmpRoot, 'src', 'features');
      fs.mkdirSync(childDir, { recursive: true });
      expect(discoverConfigPath(childDir)).toBe(configPath);
    });

    it('throws ConfigNotFoundError when no plune.yaml found in tree', () => {
      expect(() => discoverConfigPath(tmpRoot)).toThrow(ConfigNotFoundError);
    });

    it('thrown ConfigNotFoundError has code CFG_NOT_FOUND', () => {
      try {
        discoverConfigPath(tmpRoot);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigNotFoundError);
        expect((err as ConfigNotFoundError).code).toBe('CFG_NOT_FOUND');
      }
    });

    it('stops traversal after at most 50 steps without finding config', () => {
      let dir = tmpRoot;
      for (let i = 0; i < 55; i++) {
        dir = path.join(dir, `d${i}`);
        fs.mkdirSync(dir, { recursive: true });
      }
      expect(() => discoverConfigPath(dir)).toThrow(ConfigNotFoundError);
    });
  });

  describe('override mode', () => {
    it('returns the override path when the file exists', () => {
      const override = path.join(tmpRoot, 'custom.yaml');
      fs.writeFileSync(override, 'version: 1');
      expect(discoverConfigPath(tmpRoot, override)).toBe(override);
    });

    it('throws ConfigNotFoundError when override path does not exist', () => {
      const override = path.join(tmpRoot, 'nonexistent.yaml');
      expect(() => discoverConfigPath(tmpRoot, override)).toThrow(ConfigNotFoundError);
    });

    it('override does not traverse — returns exact path or throws', () => {
      const parentConfig = path.join(tmpRoot, 'plune.yaml');
      fs.writeFileSync(parentConfig, 'version: 1');
      const override = path.join(tmpRoot, 'other.yaml');
      expect(() => discoverConfigPath(tmpRoot, override)).toThrow(ConfigNotFoundError);
    });
  });
});
