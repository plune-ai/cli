// Shared presentation helpers for the console/markdown renderers.

/** Shorten `s` to at most `maxChars`, appending a marker when it was cut. */
export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + '… (truncated)';
}
