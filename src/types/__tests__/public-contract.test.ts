import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Golden snapshot of the public surface — frozen within schemaVersion: 1 (ADR-TC01, ADR-TC02).
// To bump: update SCHEMA_VERSION, update GOLDEN_EXPORTS, and increment RunResult.schemaVersion.
const SCHEMA_VERSION = 1;
const GOLDEN_EXPORTS = new Set([
  'RunResult',
  'EvalResult',
  'RowResult',
  'AssertionResultRecord',
  'Summary',
  'Usage',
  'RunError',
]);

function extractExportedNames(source: string): Set<string> {
  const names = new Set<string>();
  // Match export type { A, B as C, ... } from '...'
  // and plain export type { A, B }
  const blockRe = /export\s+type\s*\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(source)) !== null) {
    const block = m[1] ?? '';
    for (const part of block.split(',')) {
      // Handle "Foo as Bar" (only the exported name matters)
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = /(\w+)\s+as\s+(\w+)/.exec(trimmed);
      names.add(asMatch ? (asMatch[2] ?? '') : trimmed);
    }
  }
  return names;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicTsPath = join(__dirname, '..', 'public.ts');

describe('golden contract test — public surface guard (AC-07, AC-07b)', () => {
  it('public.ts exports exactly the schemaVersion:1 golden set', () => {
    const source = readFileSync(publicTsPath, 'utf-8');
    const actual = extractExportedNames(source);

    const added = [...actual].filter((n) => !GOLDEN_EXPORTS.has(n));
    const removed = [...GOLDEN_EXPORTS].filter((n) => !actual.has(n));

    if (added.length > 0 || removed.length > 0) {
      const lines: string[] = [
        `PUBLIC SURFACE CHANGE DETECTED — schema bump required (schema: ${SCHEMA_VERSION} → ${SCHEMA_VERSION + 1}).`,
      ];
      if (added.length > 0) lines.push(`  Added:   ${added.join(', ')}`);
      if (removed.length > 0) lines.push(`  Removed: ${removed.join(', ')}`);
      lines.push('Action: bump RunResult.schemaVersion, update SCHEMA_VERSION and GOLDEN_EXPORTS in this test.');
      throw new Error(lines.join('\n'));
    }

    expect(actual.size).toBe(GOLDEN_EXPORTS.size);
  });

  it('all golden exports are present in public.ts', () => {
    const source = readFileSync(publicTsPath, 'utf-8');
    const actual = extractExportedNames(source);

    for (const name of GOLDEN_EXPORTS) {
      expect(actual.has(name), `'${name}' must be in public.ts (it is part of the frozen public surface)`).toBe(true);
    }
  });

  it('Config is NOT in public.ts (internal type guard)', () => {
    const source = readFileSync(publicTsPath, 'utf-8');
    const actual = extractExportedNames(source);

    expect(
      actual.has('Config'),
      'Config is an internal type and must never appear in public.ts',
    ).toBe(false);
  });
});

// ── Structural pin (compile-time, enforced by `pnpm typecheck:gates`) ─────────
//
// The runtime test above pins the export-NAME set. This block pins the FIELD SHAPE of
// every public type: a rename, an added/removed field, or a type change at ANY nesting
// level breaks one of the `Equal<…>` assertions → tsc fails under tsconfig.check.json →
// the build blocks until the surface is restored or RunResult.schemaVersion is bumped
// (AC-07; data-model §Aggregate 1: "type change, or rename is a breaking change").
// vitest strips these type-only declarations; only the gate evaluates them.

import type {
  RunResult as _RunResult,
  Summary as _Summary,
  EvalResult as _EvalResult,
  RowResult as _RowResult,
  AssertionResultRecord as _AssertionResultRecord,
  Usage as _Usage,
  RunError as _RunError,
} from '../public.js';

// Canonical "are these two types structurally identical?" check (function-bivariance trick).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Expect<T extends true> = T;

// Frozen golden shapes — fully inlined to primitives so a drift at any depth breaks the pin.
interface GoldenSummary {
  total: number;
  passed: number;
  failed: number;
  errored: number;
  cost_usd: number;
  duration_ms: number;
}
interface GoldenUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
interface GoldenRunError {
  code: string;
  message: string;
}
interface GoldenAssertionResultRecord {
  type: string;
  passed: boolean;
  score?: number;
  reason?: string;
}
interface GoldenRowResult {
  vars: Record<string, unknown>;
  output: string | null;
  cached: boolean;
  usage?: GoldenUsage;
  latency_ms?: number;
  error?: GoldenRunError;
  assertions: GoldenAssertionResultRecord[];
}
interface GoldenEvalResult {
  id: string;
  tags: string[];
  rows: GoldenRowResult[];
  passed: boolean;
}
interface GoldenRunResult {
  schemaVersion: 1;
  plune_version: string;
  started_at: string;
  finished_at: string;
  config_hash: string;
  summary: GoldenSummary;
  evals: GoldenEvalResult[];
}

// Per-type pins — a failing one names exactly which public type drifted.
type _PinSummary = Expect<Equal<_Summary, GoldenSummary>>;
type _PinUsage = Expect<Equal<_Usage, GoldenUsage>>;
type _PinRunError = Expect<Equal<_RunError, GoldenRunError>>;
type _PinAssertionResultRecord = Expect<Equal<_AssertionResultRecord, GoldenAssertionResultRecord>>;
type _PinRowResult = Expect<Equal<_RowResult, GoldenRowResult>>;
type _PinEvalResult = Expect<Equal<_EvalResult, GoldenEvalResult>>;
type _PinRunResult = Expect<Equal<_RunResult, GoldenRunResult>>;

// The JS golden version marker MUST equal the RunResult.schemaVersion literal — bump them together.
type _PinSchemaVersion = Expect<Equal<_RunResult['schemaVersion'], typeof SCHEMA_VERSION>>;
