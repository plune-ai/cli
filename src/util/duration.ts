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

/** The longest delay a Node timer holds; past it, setTimeout fires after about 1 ms. */
export const MAX_TIMER_MS = 2_147_483_647;

/** A duration a timer will wait for: `parseDuration`, and refused above MAX_TIMER_MS (a timeout would fire at once). */
export function parseTimerDuration(text: string): number {
  const ms = parseDuration(text);
  if (ms > MAX_TIMER_MS)
    throw new Error(
      `Duration "${text}" is longer than a timer can wait (at most ${MAX_TIMER_MS} ms, about 24.8 days)`,
    );
  return ms;
}
