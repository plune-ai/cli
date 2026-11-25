// The text of a comparison's mismatches: what a person, or a model, reads to explain a failed check without
// running anything. Pure. The order is the comparison's and the wording is fixed, so the text of the same
// mismatches is the same on every run.

import type { Mismatch } from './compare.js';

/** A fragment longer than this, as compact JSON, is cut and its full length is given. */
export const MAX_FRAGMENT = 120;
/** How many mismatches are written out; the rest are counted in a last line. */
export const MAX_LISTED = 10;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Compact JSON on one line: `JSON.stringify` escapes every line break and control character. */
function fragment(value: unknown): string {
  const json = JSON.stringify(value);
  if (json.length <= MAX_FRAGMENT) return json;
  // Not through the middle of a surrogate pair: half of one is not a character.
  const last = json.charCodeAt(MAX_FRAGMENT - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_FRAGMENT - 1 : MAX_FRAGMENT;
  return `${json.slice(0, end)}... (${json.length} characters)`;
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
      return `array too large to match in any order: ${m.detail}`;
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
