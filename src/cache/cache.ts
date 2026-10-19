// Local SQLite completion cache (ADR-CA01/CA02). Dirty edge: file I/O via better-sqlite3.
// Synchronous (single-process CLI → no concurrent interleaving). Stores CompletionResponse keyed
// by the precomputed cacheKey() (S1). The cache is an OPTIMIZATION, not a source of truth — every
// failure degrades to a miss / best-effort, never crashing the run (deliberate fail-loud exception).

import { createRequire } from 'node:module';
import type DatabaseType from 'better-sqlite3';
import type { CompletionResponse } from '../types/provider.js';
import { CACHE_POLICY_VERSION } from '../util/hash.js';

const SCHEMA_VERSION = 1;
const META_DDL = 'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);';
const COMPLETIONS_DDL =
  'CREATE TABLE IF NOT EXISTS completions (cache_key TEXT PRIMARY KEY, output TEXT NOT NULL, ' +
  'input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, created_at INTEGER NOT NULL);';

export interface Cache {
  /** Return the cached completion, or undefined on a miss. `maxAgeMs` (optional) expires old entries. */
  get(key: string, opts?: { maxAgeMs?: number }): CompletionResponse | undefined;
  set(key: string, value: CompletionResponse): void;
  /** Remove one entry (a cached answer that turned out unusable). Best-effort. */
  delete(key: string): void;
  /** Entries left by an older policy version, found when the store was opened (0 when none or unknown). */
  readonly staleEntries?: number;
  clear(): void;
  close(): void;
}

export interface OpenCacheOptions {
  /** Injected clock for deterministic TTL tests (default Date.now). */
  now?: () => number;
  /** Policy version the store is opened for (default CACHE_POLICY_VERSION); a different stored one makes entries stale. */
  policyVersion?: number;
}

/** Finish reasons that mark an answer as cut off or failed: never worth replaying. */
const UNCACHEABLE_FINISH = new Set(['length', 'max_tokens', 'error', 'content_filter', 'pause_turn']);

/**
 * The minimum check before a completion may be stored: some text, not cut off by the token limit,
 * no provider error in the body. Checks that depend on the answer's format run in the orchestrator.
 */
export function isCacheable(res: CompletionResponse): boolean {
  if (res.output.trim() === '') return false;
  return res.finish_reason === undefined || !UNCACHEABLE_FINISH.has(res.finish_reason);
}

interface Row {
  output: string;
  input_tokens: number;
  output_tokens: number;
  created_at: number;
}

let missingNoted = false;

/**
 * better-sqlite3 is an optional dependency: on a machine with no prebuilt binary and no compiler
 * npm skips it and the CLI still installs. Without it the cache is off (every call is a miss).
 */
function loadDatabase(): typeof DatabaseType | undefined {
  try {
    return createRequire(import.meta.url)('better-sqlite3') as typeof DatabaseType;
  } catch {
    if (!missingNoted) {
      missingNoted = true;
      console.error(
        'plune: completion cache disabled (better-sqlite3 is not installed or failed to load). ' +
          'Reinstall with a C++ toolchain and Python available, or ignore: runs work without the cache.',
      );
    }
    return undefined;
  }
}

export function openCache(file: string, opts: OpenCacheOptions = {}): Cache {
  const now = opts.now ?? Date.now;
  const Database = loadDatabase();
  if (Database === undefined) return new NoOpCache();
  try {
    const db = new Database(file);
    try {
      ensureSchema(db);
    } catch (err) {
      db.close();
      throw err;
    }
    let stale: number;
    try {
      stale = markPolicy(db, opts.policyVersion ?? CACHE_POLICY_VERSION);
    } catch (err) {
      db.close();
      throw err;
    }
    return new SqliteCache(db, now, stale);
  } catch {
    // Corrupt / unopenable file → degrade to a no-op (always miss). Cache is an optimization (FR-7).
    return new NoOpCache();
  }
}

function ensureSchema(db: DatabaseType.Database): void {
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

/**
 * Record the policy version. Entries written under another one can never be hit again (the version is
 * in the key), so they are counted and dropped; the count is what the run reports, once.
 */
function markPolicy(db: DatabaseType.Database, version: number): number {
  const current = String(version);
  const stored = (
    db.prepare("SELECT value FROM meta WHERE key = 'policy_version'").get() as
      | { value: string }
      | undefined
  )?.value;
  if (stored === current) return 0;
  return db.transaction((): number => {
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM completions').get() as { n: number };
    db.exec('DELETE FROM completions');
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('policy_version', current);
    return n;
  })();
}

class SqliteCache implements Cache {
  constructor(
    private readonly db: DatabaseType.Database,
    private readonly now: () => number,
    readonly staleEntries: number,
  ) {}

  get(key: string, opts: { maxAgeMs?: number } = {}): CompletionResponse | undefined {
    try {
      const row = this.db
        .prepare('SELECT output, input_tokens, output_tokens, created_at FROM completions WHERE cache_key = ?')
        .get(key) as Row | undefined;
      if (row === undefined) return undefined;
      // A damaged row (wrong column types) is a miss, never a made-up answer.
      if (
        typeof row.output !== 'string' ||
        !Number.isFinite(row.input_tokens) ||
        !Number.isFinite(row.output_tokens) ||
        !Number.isFinite(row.created_at)
      ) {
        return undefined;
      }
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

  delete(key: string): void {
    try {
      this.db.prepare('DELETE FROM completions WHERE cache_key = ?').run(key);
    } catch {
      /* best-effort (FR-7) */
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
  delete(): void {
    /* no-op */
  }
  clear(): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
}
