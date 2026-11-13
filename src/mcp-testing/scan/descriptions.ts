import type { CheckLevel } from '../lint/types.js';
import type { McpSnapshot } from '../snapshot/snapshot.js';
import { DESCRIPTION_PHRASES } from './phrases.js';

/**
 * The `scan/desc/*` rules of `plune mcp scan` (docs/features/mcp-scan/threat-catalog.md, MCP-G2): text a model reads in
 * a server's lists but a person does not see, and wording aimed at the model. Two steps, each pure: a walk turns a
 * snapshot into flat texts (`descriptionTexts`), the rules read each text as sent, before any Unicode normalisation,
 * which would hide what they look for. No network, no files; the command and its exit codes are MCP-G6's.
 *
 * Nothing a server sent reaches a finding raw: what an agent reads in a report must not become an injection itself. A
 * text is shown as an excerpt of at most 80 characters with every character that does not print as its code point.
 */

/** The class names of the rule catalog (`measured`, where the lint result format says `measure`). */
export type ScanClass = 'deterministic' | 'measured' | 'heuristic';
/** The lint levels and `advice`, the only level of a heuristic. */
export type ScanLevel = CheckLevel | 'advice';
/** `yes`: gates from the first day; `after-measure`: once MCP-G7 has measured it on the corpus; `no`: never by default. */
export type ScanGating = 'yes' | 'after-measure' | 'no';

export interface ScanRule {
  class: ScanClass;
  level: ScanLevel;
  gating: ScanGating;
  fix: string;
}

/** The rows of the catalog whose task is MCP-G2, in its order; a test reads the catalog table against this. */
export const DESC_RULES = {
  'scan/desc/tag-character': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Remove the Unicode tag characters (U+E0000..U+E007F); no description needs them.',
  },
  'scan/desc/bidi-control': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Remove the bidi embedding, override and isolate characters; write the text in its reading order.',
  },
  'scan/desc/zero-width': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Remove the zero-width space, word joiner or byte order mark inside the text.',
  },
  'scan/desc/joiner-or-direction-mark': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Remove the joiner or direction mark unless the script of the text needs it.',
  },
  'scan/desc/ansi-escape': {
    class: 'deterministic',
    level: 'error',
    gating: 'yes',
    fix: 'Remove the terminal escape sequence; a description is text, not terminal output.',
  },
  'scan/desc/control-character': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Remove the control character; only line ends and tabs belong in a description.',
  },
  'scan/desc/html-comment': {
    class: 'deterministic',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Remove the HTML comment: a client that renders Markdown or HTML hides it from the person.',
  },
  'scan/desc/encoded-blob': {
    class: 'measured',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Write the text plainly instead of as base64, or remove it.',
  },
  'scan/desc/oversized-text': {
    class: 'measured',
    level: 'warn',
    gating: 'after-measure',
    fix: 'Shorten the text; the part past the limit was not checked.',
  },
  'scan/desc/override-instruction': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Read the text: a description says what the tool does, it does not tell the model to set aside other instructions.',
  },
  'scan/desc/sensitive-path': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Read the text: check that the tool needs this path, and that nothing asks the model to read credentials.',
  },
  'scan/desc/conceal-from-user': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Read the text: a description must not ask the model to keep anything from the person.',
  },
  'scan/desc/call-other-tool-first': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Read the text: check that the call it asks for first is part of the tool’s own work.',
  },
  'scan/desc/param-asks-for-context': {
    class: 'heuristic',
    level: 'advice',
    gating: 'no',
    fix: 'Read the text: a parameter should ask for its own value, not for the conversation, files or other tools’ output.',
  },
} as const satisfies Record<string, ScanRule>;

export type DescRuleId = keyof typeof DESC_RULES;

/** A line longer than this many bytes of UTF-8 is scanned up to it, with a `scan/desc/oversized-text` finding. */
export const MAX_TEXT_BYTES = 1024 * 1024;
// ponytail: provisional threshold until MCP-G7 measures base64 runs on the corpus; the rule stays warn until then.
const MIN_BASE64_RUN = 64;
const EXCERPT = 80;

/** The section of the snapshot a text comes from. */
export type Surface = 'instructions' | 'tools' | 'prompts' | 'resources' | 'resourceTemplates';

/** One text of a snapshot, flat: where it is, and what it says as sent. */
export interface ScannedText {
  /** A JSON Pointer; a segment with a character that does not print shows its code point (`[U+202E]`). */
  pointer: string;
  surface: Surface;
  text: string;
  /** The text is a key of an object (a property name), not a value; the pointer then names the member. */
  key: boolean;
  /** The text is the description of a string parameter. */
  stringParam: boolean;
}

export interface DescriptionFinding {
  rule: DescRuleId;
  class: ScanClass;
  level: ScanLevel;
  /** Whether it may change the exit code now: only a `gating: yes` rule. A heuristic is always false. */
  gating: boolean;
  surface: Surface;
  pointer: string;
  key: boolean;
  /** In code points from the start of the text. */
  offset: number;
  /** The code points found (`U+202E`), or what kind of match it is. */
  match: string;
  /** One sentence, as a report prints it after the pointer. */
  message: string;
  /** The text from `offset` on, escaped and at most 80 characters. */
  excerpt: string;
  fix: string;
  /** With `showDecoded`: the text the tag characters spell, escaped and at most 80 characters. */
  decoded?: string;
}

export interface DescriptionScan {
  /** `nothing-to-scan`: the snapshot held no text at all; that is not the same as clean. */
  status: 'scanned' | 'nothing-to-scan';
  texts: number;
  /** The version of the phrase lists the heuristics read. */
  phrasesVersion: number;
  findings: DescriptionFinding[];
}

export interface ScanOptions {
  /** Add the text that tag characters spell to their finding (`--show-decoded`), still escaped and bounded. */
  showDecoded?: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const U = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
const SHOWN = /^[\p{L}\p{N}\p{P}\p{S} ]$/u;

/** `s` with every character that does not print as `[U+XXXX]`, cut to `max` characters with `...`. */
export function visible(s: string, max = EXCERPT): string {
  const pieces: string[] = [];
  let len = 0;
  for (const ch of s) {
    const piece = SHOWN.test(ch) ? ch : `[${U(ch.codePointAt(0)!)}]`;
    pieces.push(piece);
    len += [...piece].length;
    if (len > max) {
      while (len > max - 3) len -= [...pieces.pop()!].length;
      return `${pieces.join('')}...`;
    }
  }
  return pieces.join('');
}

const segment = (s: string | number) =>
  typeof s === 'number' ? String(s) : visible(s.replace(/~/g, '~0').replace(/\//g, '~1'), Infinity);
const pointerOf = (path: (string | number)[]) => `/${path.map(segment).join('/')}`;

const hasStringType = (schema: Record<string, unknown>) =>
  schema['type'] === 'string' ||
  (Array.isArray(schema['type']) && schema['type'].includes('string'));

/**
 * Every text of a snapshot the rules read: the name, title and description of a tool and its `annotations.title`;
 * every key and string value at any depth of `inputSchema` and `outputSchema` (descriptions, titles, property names,
 * `enum`, `default`, `examples` and the rest); the name, title, description and arguments of a prompt; the name,
 * title, description and address of a resource or a resource template; the server's `instructions`. Empty text is
 * not a text.
 */
export function descriptionTexts(snapshot: McpSnapshot): ScannedText[] {
  const out: ScannedText[] = [];
  const add = (
    surface: Surface,
    path: (string | number)[],
    v: unknown,
    key = false,
    stringParam = false,
  ) => {
    if (typeof v === 'string' && v !== '')
      out.push({ pointer: pointerOf(path), surface, text: v, key, stringParam });
  };
  const schema = (path: (string | number)[], node: unknown): void => {
    if (typeof node === 'string') add('tools', path, node);
    else if (Array.isArray(node)) node.forEach((v, i) => schema([...path, i], v));
    else if (isRecord(node)) {
      const param = path.at(-2) === 'properties' && hasStringType(node);
      for (const [k, v] of Object.entries(node)) {
        add('tools', [...path, k], k, true);
        if (k === 'description' && typeof v === 'string')
          add('tools', [...path, k], v, false, param);
        else schema([...path, k], v);
      }
    }
  };
  const fields = (
    surface: Surface,
    path: (string | number)[],
    entity: unknown,
    names: readonly string[],
  ) => {
    if (isRecord(entity)) for (const f of names) add(surface, [...path, f], entity[f]);
  };

  add('instructions', ['instructions'], snapshot.instructions);
  snapshot.tools?.forEach((t, i) => {
    fields('tools', ['tools', i], t, ['name', 'title', 'description']);
    fields('tools', ['tools', i, 'annotations'], t.annotations, ['title']);
    for (const f of ['inputSchema', 'outputSchema'] as const)
      if (t[f] !== undefined) schema(['tools', i, f], t[f]);
  });
  snapshot.prompts?.forEach((p, i) => {
    fields('prompts', ['prompts', i], p, ['name', 'title', 'description']);
    if (Array.isArray(p.arguments))
      p.arguments.forEach((a, j) =>
        fields('prompts', ['prompts', i, 'arguments', j], a, ['name', 'title', 'description']),
      );
  });
  snapshot.resources?.forEach((r, i) =>
    fields('resources', ['resources', i], r, ['uri', 'name', 'title', 'description']),
  );
  snapshot.resourceTemplates?.forEach((r, i) =>
    fields('resourceTemplates', ['resourceTemplates', i], r, [
      'uriTemplate',
      'name',
      'title',
      'description',
    ]),
  );
  return out;
}

type Hit = { rule: DescRuleId; offset: number; match: string; message: string; decoded?: string };

const NAMES: Record<number, string> = {
  0x202a: 'left-to-right embedding',
  0x202b: 'right-to-left embedding',
  0x202c: 'pop directional formatting',
  0x202d: 'left-to-right override',
  0x202e: 'right-to-left override',
  0x2066: 'left-to-right isolate',
  0x2067: 'right-to-left isolate',
  0x2068: 'first strong isolate',
  0x2069: 'pop directional isolate',
  0x200b: 'zero-width space',
  0x2060: 'word joiner',
  0xfeff: 'zero-width no-break space',
  0x200c: 'zero-width non-joiner',
  0x200d: 'zero-width joiner',
  0x200e: 'left-to-right mark',
  0x200f: 'right-to-left mark',
  0x061c: 'Arabic letter mark',
};
const NOUNS: Partial<Record<DescRuleId, string>> = {
  'scan/desc/bidi-control': 'bidi controls',
  'scan/desc/zero-width': 'zero-width characters',
  'scan/desc/joiner-or-direction-mark': 'joiners or direction marks',
  'scan/desc/control-character': 'control characters',
};

// ponytail: scripts listed by hand (the ones that write right to left, and the ones that use joiners between letters);
// MCP-G7 measures these bounds on the corpus, and a script missing here shows there as a false finding.
const RTL =
  /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Adlam}]/u;
const JOINING =
  /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Mongolian}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const EMOJI_BEFORE_ZWJ = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]/u;
const EMOJI = /\p{Extended_Pictographic}/u;

/** A ZWNJ or ZWJ beside a letter of a script that joins, or a ZWJ inside an emoji sequence. */
function joinerNeeded(cps: string[], i: number): boolean {
  const prev = cps[i - 1] ?? '';
  const next = cps[i + 1] ?? '';
  if (JOINING.test(prev) || JOINING.test(next)) return true;
  return cps[i] === '‍' && EMOJI_BEFORE_ZWJ.test(prev) && EMOJI.test(next);
}

/** The rule a single character sets off, if any. ESC and CSI are handled apart, with their sequence. */
function charRule(cps: string[], i: number, rtl: boolean): DescRuleId | undefined {
  const c = cps[i]!.codePointAt(0)!;
  if (c >= 0xe0000 && c <= 0xe007f) return 'scan/desc/tag-character';
  if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return 'scan/desc/bidi-control';
  if (c === 0x200b || c === 0x2060 || c === 0xfeff)
    return i === 0 ? undefined : 'scan/desc/zero-width';
  if (c === 0x200c || c === 0x200d)
    return joinerNeeded(cps, i) ? undefined : 'scan/desc/joiner-or-direction-mark';
  if (c === 0x200e || c === 0x200f || c === 0x061c)
    return rtl ? undefined : 'scan/desc/joiner-or-direction-mark';
  // C0 and C1, and DEL between them, except the line ends and the tab.
  if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f))
    return 'scan/desc/control-character';
  return undefined;
}

const decodeTags = (run: string[]) =>
  run
    .map((ch) => ch.codePointAt(0)! - 0xe0000)
    .filter((c) => c >= 0x20 && c <= 0x7e)
    .map((c) => String.fromCharCode(c))
    .join('');

/** Character rules over the code points, a run of the same rule as one finding. */
function charHits(cps: string[], opts: ScanOptions): Hit[] {
  const hits: Hit[] = [];
  const rtl = RTL.test(cps.join(''));
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!.codePointAt(0)!;
    if (c === 0x1b || c === 0x9b) {
      // A CSI sequence (ESC [ or CSI, then parameters and a final byte), an OSC string (ESC ]), or one character.
      const rest = cps.slice(i + 1, i + 40).join('');
      const seq =
        (c === 0x1b
          ? /^(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]{0,32}|[\s\S])?/
          : /^[0-?]*[ -/]*[@-~]/
        ).exec(rest)?.[0] ?? '';
      const shown = `${c === 0x1b ? 'ESC' : 'CSI'}${seq === '' ? '' : ` ${visible(seq, 20)}`}`;
      hits.push({
        rule: 'scan/desc/ansi-escape',
        offset: i,
        match: U(c),
        message: `terminal escape ${shown} at offset ${i}`,
      });
      continue;
    }
    const rule = charRule(cps, i, rtl);
    if (rule === undefined) continue;
    let end = i + 1;
    while (end < cps.length && charRule(cps, end, rtl) === rule) end++;
    const run = cps.slice(i, end);
    const points = run.map((ch) => U(ch.codePointAt(0)!));
    if (rule === 'scan/desc/tag-character') {
      const shown = points.length > 2 ? `${points.slice(0, 2).join(' ')} ...` : points.join(' ');
      hits.push({
        rule,
        offset: i,
        match: shown,
        message: `${run.length} Unicode tag character${run.length === 1 ? '' : 's'} from offset ${i} (${shown}); pass --show-decoded to see them as text`,
        ...(opts.showDecoded ? { decoded: visible(decodeTags(run)) } : {}),
      });
    } else {
      const shown = points.length > 3 ? `${points.slice(0, 3).join(' ')} ...` : points.join(' ');
      const message =
        run.length === 1
          ? `${NAMES[c] ?? 'control character'} ${shown} at offset ${i}`
          : `${run.length} ${NOUNS[rule]} from offset ${i} (${shown})`;
      hits.push({ rule, offset: i, match: shown, message });
    }
    i = end - 1;
  }
  return hits;
}

/** UTF-16 index to code point offset, for indexes asked in increasing order. */
function codePointCounter(text: string): (index: number) => number {
  let unit = 0;
  let count = 0;
  return (index) => {
    for (; unit < index; unit++) {
      const c = text.charCodeAt(unit);
      if (
        !(
          c >= 0xdc00 &&
          c <= 0xdfff &&
          unit > 0 &&
          text.charCodeAt(unit - 1) >= 0xd800 &&
          text.charCodeAt(unit - 1) <= 0xdbff
        )
      )
        count++;
    }
    return count;
  };
}

function matches(text: string, re: RegExp): { offset: number; text: string }[] {
  const at = codePointCounter(text);
  return [...text.matchAll(re)].map((m) => ({ offset: at(m.index), text: m[0] }));
}

const PRINTABLE_TEXT = /^[\p{L}\p{N}\p{P}\p{S}\s]+$/u;
function decodesToText(run: string): boolean {
  try {
    const bytes = Buffer.from(run.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    return PRINTABLE_TEXT.test(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return false;
  }
}

type HeuristicId = keyof typeof DESCRIPTION_PHRASES.rules;
const PHRASES = Object.fromEntries(
  Object.entries(DESCRIPTION_PHRASES.rules).map(([id, list]) => [
    id,
    new RegExp(list.map((p) => `(?:${p.replace(/ /g, '\\s+')})`).join('|'), 'giu'),
  ]),
) as Record<HeuristicId, RegExp>;
const SAYS: Record<HeuristicId, (m: string) => string> = {
  'scan/desc/override-instruction': (m) => `phrase "${m}"`,
  'scan/desc/sensitive-path': (m) => `mentions "${m}"`,
  'scan/desc/conceal-from-user': (m) => `phrase "${m}"`,
  'scan/desc/call-other-tool-first': (m) => `asks to call another tool first: "${m}"`,
  'scan/desc/param-asks-for-context': (m) => `asks to put "${m}" into this parameter`,
};

function textHits(text: string, item: ScannedText): Hit[] {
  const hits: Hit[] = [];
  // indexOf, not a lazy pattern: a regex rescans to the end for every unclosed `<!--`, quadratic on a hostile text.
  const at = codePointCounter(text);
  for (let start = text.indexOf('<!--'); start !== -1; ) {
    const end = text.indexOf('-->', start + 4);
    if (end === -1) break;
    const offset = at(start);
    hits.push({
      rule: 'scan/desc/html-comment',
      offset,
      match: 'html-comment',
      message: `HTML comment of ${[...text.slice(start, end + 3)].length} characters at offset ${offset}`,
    });
    start = text.indexOf('<!--', end + 3);
  }
  for (const m of matches(text, new RegExp(`[A-Za-z0-9+/_-]{${MIN_BASE64_RUN},}={0,2}`, 'g'))) {
    if (!decodesToText(m.text)) continue;
    hits.push({
      rule: 'scan/desc/encoded-blob',
      offset: m.offset,
      match: 'base64',
      message: `base64 run of ${m.text.length} characters at offset ${m.offset} decodes to printable text`,
    });
  }
  for (const id of Object.keys(PHRASES) as HeuristicId[]) {
    if (id === 'scan/desc/param-asks-for-context' && !item.stringParam) continue;
    for (const m of matches(text, PHRASES[id])) {
      const shown = visible(m.text, 60);
      hits.push({
        rule: id,
        offset: m.offset,
        match: shown,
        message: `${SAYS[id](shown)} at offset ${m.offset}`,
      });
    }
  }
  return hits;
}

function scanText(item: ScannedText, opts: ScanOptions): DescriptionFinding[] {
  let text = item.text;
  const hits: Hit[] = [];
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    // A character cut in two at the limit decodes to U+FFFD; it is not part of the text.
    text = Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_BYTES).toString('utf8').replace(/�$/, '');
    const offset = [...text].length;
    hits.push({
      rule: 'scan/desc/oversized-text',
      offset,
      match: 'size',
      message: `${(bytes / MAX_TEXT_BYTES).toFixed(1)} MB, scanned the first 1 MB only`,
    });
  }
  const cps = [...text];
  hits.push(...charHits(cps, opts), ...textHits(text, item));
  return hits
    .sort((a, b) => a.offset - b.offset)
    .map((h) => {
      const rule = DESC_RULES[h.rule];
      return {
        rule: h.rule,
        class: rule.class,
        level: rule.level,
        gating: rule.gating === 'yes',
        surface: item.surface,
        pointer: item.pointer,
        key: item.key,
        offset: h.offset,
        match: h.match,
        message: rule.class === 'heuristic' ? `${h.message} (advice)` : h.message,
        excerpt: visible(cps.slice(h.offset, h.offset + EXCERPT * 2).join('')),
        fix: rule.fix,
        ...(h.decoded !== undefined ? { decoded: h.decoded } : {}),
      };
    });
}

/**
 * Scan every text of a snapshot (`descriptionTexts`) with the `scan/desc/*` rules. A snapshot with no text at all is
 * `nothing-to-scan`, never a clean result.
 */
export function scanDescriptions(snapshot: McpSnapshot, opts: ScanOptions = {}): DescriptionScan {
  const texts = descriptionTexts(snapshot);
  return {
    status: texts.length === 0 ? 'nothing-to-scan' : 'scanned',
    texts: texts.length,
    phrasesVersion: DESCRIPTION_PHRASES.version,
    findings: texts.flatMap((t) => scanText(t, opts)),
  };
}

/** A finding as one report line: its pointer and its message, both already escaped. */
export const formatDescriptionFinding = (f: DescriptionFinding): string =>
  `${f.pointer}: ${f.message}`;

/**
 * Where `text` names one of `names`: whole names only (no letter, digit, `_` or `-` on either side) and in the same
 * letter case, or `list` would match half the sentences. The caller gives the names: for `scan/cross/foreign-tool-reference`
 * (MCP-G4), the tools of the other servers. Offsets in code points, in the order they appear.
 */
export function findToolNames(
  text: string,
  names: readonly string[],
): { name: string; offset: number }[] {
  const found: { name: string; offset: number }[] = [];
  for (const name of new Set(names)) {
    if (name === '') continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    for (const m of matches(
      text,
      new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`, 'gu'),
    ))
      found.push({ name, offset: m.offset });
  }
  return found.sort((a, b) => a.offset - b.offset);
}
