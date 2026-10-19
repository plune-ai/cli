// "90s", "15m", "12h", "7d" or a bare number of milliseconds → ms. Used by --cache-max-age.

const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Throws on anything else (zero, negative, unknown unit); the CLI maps it to a usage error. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(text.trim());
  const ms = m === null ? NaN : Number(m[1]) * UNIT_MS[m[2] ?? 'ms']!;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`Invalid duration "${text}" (use e.g. 90s, 15m, 12h, 7d)`);
  }
  return ms;
}
