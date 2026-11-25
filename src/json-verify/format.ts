// The text of a comparison's mismatches: what a person, or a model, reads to explain a failed check without
// running anything. Pure. The order is the comparison's and the wording is fixed, so the text of the same
// mismatches is the same on every run.

import type { Mismatch } from './compare.js';

/** A fragment longer than this, as compact JSON, is cut. */
export const MAX_FRAGMENT = 120;
/** A fragment is written this many levels deep; what lies deeper is `...`. */
export const MAX_FRAGMENT_DEPTH = 6;
/** How many mismatches are written out; the rest are counted in a last line. */
export const MAX_LISTED = 10;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/**
 * Compact JSON on one line: `JSON.stringify` escapes every line break and control character of a string.
 * The value is a model's answer, of any size and depth, so it is not handed to `JSON.stringify` whole: that
 * recurses as deep as the value and throws on a few thousand levels. It is written here, down to a fixed depth
 * and only until the fragment is long enough to cut.
 */
function fragment(value: unknown): string {
  let out = '';
  const write = (v: unknown, depth: number): void => {
    if (typeof v !== 'object' || v === null) {
      out += JSON.stringify(typeof v === 'string' ? v.slice(0, MAX_FRAGMENT) : v);
    } else if (depth === MAX_FRAGMENT_DEPTH) {
      out += '...';
    } else {
      const list = Array.isArray(v);
      out += list ? '[' : '{';
      let n = 0;
      for (const [key, item] of list ? v.entries() : Object.entries(v)) {
        if (out.length > MAX_FRAGMENT) return;
        if (n++ > 0) out += ',';
        if (!list) out += `${JSON.stringify(key)}:`;
        write(item, depth + 1);
      }
      out += list ? ']' : '}';
    }
  };
  write(value, 0);
  if (out.length <= MAX_FRAGMENT) return out;
  // Not through the middle of a surrogate pair: half of one is not a character.
  const last = out.charCodeAt(MAX_FRAGMENT - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_FRAGMENT - 1 : MAX_FRAGMENT;
  return `${out.slice(0, end)}...`;
}

function reasonText(m: Mismatch): string {
  switch (m.reason) {
    case 'missing-key':
      return 'missing key';
    case 'extra-key':
      return 'extra key';
    case 'type':
      return `type differs: expected ${typeOf(m.expected)}, got ${typeOf(m.actual)}`;
    case 'value':
      return 'value differs';
    case 'function':
      return `function not satisfied: ${m.detail}`;
    case 'missing-element':
      return 'missing element';
    case 'extra-element':
      return 'extra element';
    case 'no-match':
      return 'no match for an array element';
    case 'too-large':
      return `too large: ${m.detail}`;
  }
}

/**
 * The mismatches as text: a count, then for each its JSON path, the reason, and the expected and actual
 * fragments it has. Empty for an empty list. The lines after the first are indented, so the text reads as one
 * item wherever a reporter puts it after the name of the check.
 */
export function formatMismatches(list: readonly Mismatch[]): string {
  if (list.length === 0) return '';
  const lines = [`${list.length} ${list.length === 1 ? 'mismatch' : 'mismatches'}`];
  for (const m of list.slice(0, MAX_LISTED)) {
    lines.push(`    ${m.path}: ${reasonText(m)}`);
    if (m.expected !== undefined) lines.push(`      expected: ${fragment(m.expected)}`);
    if (m.actual !== undefined) lines.push(`      actual:   ${fragment(m.actual)}`);
  }
  if (list.length > MAX_LISTED) lines.push(`    and ${list.length - MAX_LISTED} more`);
  return lines.join('\n');
}
