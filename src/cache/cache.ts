// Local SQLite completion cache (ADR-CA01/CA02). Dirty edge: file I/O via better-sqlite3.
// Synchronous (single-process CLI → no concurrent interleaving). Stores CompletionResponse keyed
// by the precomputed cacheKey() (S1). The cache is an OPTIMIZATION, not a source of truth — every
// failure degrades to a miss / best-effort, never crashing the run (deliberate fail-loud exception).

import Database from 'better-sqlite3';
import type { CompletionResponse } from '../types/provider.js';

const SCHEMA_VERSION = 1;
const META_DDL = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);';
const COMPLETIONS_DDL =
  'CREATE TABLE IF NOT EXISTS completions (cache_key TEXT PRIMARY KEY, output TEXT NOT NULL, ' +
  'input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL);';

export interface Cache {
  /** Return the cached completion, or undefined on a miss. `maxAgeMs` (optional) expires old entries. */
  get(key: string, opts?: { maxAgeMs?: number }): CompletionResponse | undefined;
  set(key: string, value: CompletionResponse): void;
  clear(): void;
  close(): void;
}

export interface OpenCacheOptions {
  /** Injected clock for deterministic TTL tests (default Date.now). */
  now?: () => number;
}

interface Row {
  output: string;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
}

export function openCache(file: string, opts: OpenCacheOptions = {}): Cache {
  const now = opts.now ?? Date.now;
  try {
    const db = new Database(file);
    try {
      ensureSchema(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return new SqliteCache(db, now);
  } catch {
    // Corrupt / unopenable file → degrade to a no-op (always miss). Cache is an optimization (FR-7).
    return new NoOpCache();
  }
}

function ensureSchema(db: Database.Database): void {
  db.exec(META_DDL + COMPLETIONS_DDL);
  const stored = (
    db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
  )?.value;
  const current = String(SCHEMA_VERSION);
  if (stored !== current) {
    // Fresh (undefined) or stale version → (re)build completions to the current schema (FR-6).
    db.exec('DROP TABLE IF EXISTS completions');
    db.exec(COMPLETIONS_DDL);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', current);
  }
}

class SqliteCache implements Cache {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
  ) {}

  get(key: string, opts: { maxAgeMs?: number } = {}): CompletionResponse | undefined {
    try {
      const row = this.db
        .prepare('SELECT output, input_tokens, output_tokens, created_at FROM completions WHERE cache_key = ?')
        .get(key) as Row | undefined;
      if (row === undefined) return undefined;
      // Hybrid TTL: permanent unless maxAgeMs is given and the entry is older than it (FR-4).
      if (opts.maxAgeMs !== undefined && this.now() - row.created_at > opts.maxAgeMs) {
        return undefined;
      }
      return {
        output: row.output,
        usage: { input_tokens: row.input_tokens, output_tokens: row.output_tokens },
      };
    } catch {
      return undefined; // read error → miss (FR-7)
    }
  }

  set(key: string, value: CompletionResponse): void {
    try {
      this.db
        .prepare(
          `INSERT INTO completions (cache_key, output, input_tokens, output_tokens, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(cache_key) DO UPDATE SET
             output = excluded.output,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             created_at = excluded.created_at`,
        )
        .run(key, value.output, value.usage.input_tokens, value.usage.output_tokens, this.now());
    } catch {
      /* best-effort write (FR-7) */
    }
  }

  clear(): void {
    try {
      this.db.exec('DELETE FROM completions');
    } catch {
      /* best-effort (FR-7) — clear must never crash the run, even on a closed/locked db */
    }
  }

  close(): void {
    this.db.close();
  }
}

/** Degraded cache used when the store cannot be opened — always a miss, writes are no-ops. */
class NoOpCache implements Cache {
  get(): undefined {
    return undefined;
  }
  set(): void {
    /* no-op */
  }
  clear(): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}
