import { describe, it, expect } from 'vitest';

// AC-07b: public.ts re-exports RunResult tree ONLY.
// Config, Provider, Assertion and all internal types must NOT appear in public.ts.

describe('barrel structure (AC-01, AC-07b)', () => {
  it('index.ts module is importable', async () => {
    const idx = await import('../index.js');
    expect(typeof idx).toBe('object');
  });

  it('public.ts module is importable', async () => {
    const pub = await import('../public.js');
    expect(typeof pub).toBe('object');
  });
});

// ── Type-level gate (tsconfig.check.json) ─────────────────────────────────
//
// PASS: RunResult re-exported from public.ts (public surface)
// PASS: Config re-exported from index.ts (internal, in-repo barrel)
// FAIL: Config must NOT be in public.ts → verified by @ts-expect-error below
//
// These import type statements are checked by tsc; vitest strips them.

import type { RunResult, EvalResult, RowResult, AssertionResultRecord } from '../public.js';
import type { Config, ProviderConfig, AssertionConfig, Provider, Assertion } from '../index.js';

function _typeGatePublic(r: RunResult, e: EvalResult, row: RowResult, a: AssertionResultRecord) {
  void r; void e; void row; void a;
}

function _typeGateIndex(c: Config, p: ProviderConfig, ac: AssertionConfig, pr: Provider<ProviderConfig>, as_: Assertion<object>) {
  void c; void p; void ac; void pr; void as_;
}

// Config is INTERNAL — must not be exported from public.ts (AC-07b)
// @ts-expect-error — TS2305 Module has no exported member 'Config'
import type { Config as _Cfg } from '../public.js';
function _shouldFail(_c: _Cfg) { void _c; }
