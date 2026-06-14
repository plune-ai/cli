import { describe, expect, it, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { openCache, type Cache } from '../cache.js';
import type { CompletionResponse } from '../../types/provider.js';

const completion = (output: string): CompletionResponse => ({
  output,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const opened: Cache[] = [];
function freshFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plune-cache-')), 'c.db');
}
function open(file: string, opts?: { now?: () => number }): Cache {
  const c = openCache(file, opts);
  opened.push(c);
  return c;
}

afterEach(() => {
  for (const c of opened.splice(0)) {
    try {
      c.close();
    } catch {
      /* already closed */
    }
  }
});

describe('cache — core', () => {
  it('round-trips a completion including usage (AC-1, AC-8)', () => {
    const cache = open(freshFile());
    cache.set('k1', completion('hello'));
    expect(cache.get('k1')).toEqual({
      output: 'hello',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
  });

  it('returns a miss for an absent key (AC-2)', () => {
    const cache = open(freshFile());
    expect(cache.get('nope')).toBeUndefined();
  });

  it('set upserts the same key', () => {
    const cache = open(freshFile());
    cache.set('k', completion('first'));
    cache.set('k', completion('second'));
    expect(cache.get('k')?.output).toBe('second');
  });

  it('clear() empties the cache (AC-5)', () => {
    const cache = open(freshFile());
    cache.set('k', completion('x'));
    cache.clear();
    expect(cache.get('k')).toBeUndefined();
  });

  it('persists across a reopen of the same file (AC-3)', () => {
    const file = freshFile();
    const c1 = open(file);
    c1.set('k', completion('persisted'));
    c1.close();
    const c2 = open(file);
    expect(c2.get('k')?.output).toBe('persisted');
  });
});

describe('cache — TTL (AC-4)', () => {
  it('expires an entry older than maxAgeMs, keeps a fresh one, and ignores TTL by default', () => {
    let clock = 1000;
    const cache = open(freshFile(), { now: () => clock });
    cache.set('k', completion('v')); // created_at = 1000
    clock = 1000 + 5000; // 5s later

    expect(cache.get('k', { maxAgeMs: 3000 })).toBeUndefined(); // age 5000 > 3000 → miss
    expect(cache.get('k', { maxAgeMs: 10000 })?.output).toBe('v'); // age 5000 < 10000 → hit
    expect(cache.get('k')?.output).toBe('v'); // no maxAgeMs → permanent → hit
  });
});

describe('cache — resilience', () => {
  it('rebuilds when the stored schema version differs (AC-6)', () => {
    const file = freshFile();
    const c1 = open(file);
    c1.set('k', completion('old'));
    c1.close();

    // Tamper: simulate an older schema version on disk.
    const raw = new Database(file);
    raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
    raw.close();

    const c2 = open(file); // detects mismatch → rebuild
    expect(c2.get('k')).toBeUndefined(); // old data dropped
    c2.set('k2', completion('new')); // still usable
    expect(c2.get('k2')?.output).toBe('new');
  });

  it('degrades to a miss on a corrupt/unopenable file, without throwing (AC-7)', () => {
    const file = freshFile();
    fs.writeFileSync(file, 'this is not a sqlite database');
    const cache = open(file); // must not throw
    expect(cache.get('k')).toBeUndefined();
    expect(() => cache.set('k', completion('x'))).not.toThrow();
    expect(cache.get('k')).toBeUndefined();
  });

  it('degrades (no throw) when used after close (review fix: clear included)', () => {
    const cache = open(freshFile());
    cache.close();
    expect(cache.get('k')).toBeUndefined();
    expect(() => cache.set('k', completion('x'))).not.toThrow();
    expect(() => cache.clear()).not.toThrow(); // FR-7: clear must also degrade, not crash
  });
});
