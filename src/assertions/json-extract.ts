// Extract a JSON value from an LLM output (ADR-AP02). Pure — no I/O.
// `strict`: the whole (trimmed) output must be JSON. `auto`: try a ```json fenced block, then
// each successive balanced {...}/[...] run until one parses. Returns a discriminated result so a
// valid JSON `null` is never confused with "nothing found".

export type ExtractResult = { ok: true; value: unknown } | { ok: false };

export function extractJson(output: string, mode: 'auto' | 'strict'): ExtractResult {
  if (mode === 'strict') {
    return tryParse(output.trim());
  }

  const fenced = extractFencedBlock(output);
  if (fenced !== null) {
    const r = tryParse(fenced);
    if (r.ok) return r;
  }

  // Try each balanced candidate in turn — a decoy like "{as requested}" before the real JSON
  // must not abort the search (regression: review BUG #1).
  for (const run of balancedRuns(output)) {
    const r = tryParse(run);
    if (r.ok) return r;
  }

  return { ok: false };
}

function tryParse(s: string): ExtractResult {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}

/** Content of the first ```json ... ``` (or plain ``` ... ```) fenced block, trimmed. */
function extractFencedBlock(s: string): string | null {
  const m = s.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  return m?.[1]?.trim() ?? null;
}

/** Yield each balanced {...}/[...] run in order. An opener that never closes is skipped. */
function* balancedRuns(s: string): Generator<string> {
  let i = 0;
  while (i < s.length) {
    const rel = s.slice(i).search(/[{[]/);
    if (rel === -1) return;
    const start = i + rel;
    const run = balancedFrom(s, start);
    if (run === null) {
      i = start + 1; // opener never closed — advance past it and keep scanning
    } else {
      yield run;
      i = start + run.length; // continue after this run
    }
  }
}

/** The balanced {...}/[...] run beginning at `start`, string-aware so braces inside strings
 * don't break balancing. Returns null if it never closes. */
function balancedFrom(s: string, start: number): string | null {
  const open = s[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
