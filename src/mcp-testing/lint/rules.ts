import { LINT_THRESHOLDS, type LanguageCode } from './thresholds.js';
import { toolListSize } from './size.js';
import type { CheckClass, CheckLevel, CheckState, ListedTool, LintTarget } from './types.js';

/**
 * The lint rules over a `tools/list` answer. One registry entry per rule id: its class, level, fix and the place in
 * the specification it comes from. Rules read the list as data; they know nothing about a transport, a terminal or
 * files, so the same rules check our own contract in a test and any server behind a command.
 */

export interface RuleHit {
  target: LintTarget;
  message: string;
  expected: string;
  actual: string;
  /** Only when this hit is more serious than the rule's usual level. */
  level?: CheckLevel;
  /** Only when the rule could not judge the list at all; a hit is `failed` otherwise. */
  state?: Extract<CheckState, 'could-not-run'>;
}

export interface LintRule {
  id: string;
  /** What the rule finds, in one sentence: the rule catalog (`plune mcp lint --list-rules`) prints it. */
  description: string;
  class: CheckClass;
  level: CheckLevel;
  fix: string;
  specRef: string;
  check(tools: readonly ListedTool[]): RuleHit[];
}

const T = LINT_THRESHOLDS;
export const SCHEMA = 'https://modelcontextprotocol.io/specification/2025-11-25/schema';
export const TOOLS_PAGE = 'https://modelcontextprotocol.io/specification/2025-11-25/server/tools';

type Schema = Record<string, unknown>;

export const isRecord = (v: unknown): v is Schema => typeof v === 'object' && v !== null && !Array.isArray(v);
const props = (s: unknown): Schema => (isRecord(s) && isRecord(s.properties) ? s.properties : {});
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** Types a schema allows, including those of its `anyOf`/`oneOf` members. */
function schemaTypes(s: Schema): Set<string> {
  const out = new Set<string>();
  const add = (t: unknown) => {
    if (typeof t === 'string') out.add(t);
    if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);
  };
  add(s.type);
  for (const key of ['anyOf', 'oneOf'] as const) {
    const members = s[key];
    if (Array.isArray(members)) for (const m of members) if (isRecord(m)) add(m.type);
  }
  return out;
}

function hasClosedSet(s: Schema): boolean {
  if (s.enum !== undefined || s.const !== undefined) return true;
  return (['anyOf', 'oneOf'] as const).some((k) => {
    const members = s[k];
    return Array.isArray(members) && members.some((m) => isRecord(m) && (m.enum !== undefined || m.const !== undefined));
  });
}

/** No property beyond `properties` can appear: additionalProperties is false and nothing composes or extends the node. */
const OPEN_KEYWORDS = ['allOf', 'anyOf', 'oneOf', '$ref', 'if', 'dependentSchemas', 'patternProperties'] as const;
const isClosed = (s: Schema): boolean => s.additionalProperties === false && OPEN_KEYWORDS.every((k) => s[k] === undefined);

interface SchemaNode {
  path: string;
  schema: Schema;
  /** `root`: the input schema itself; `param`: a named property at any depth; `items`: the element of an array. */
  kind: 'root' | 'param' | 'items';
}

/** Every object-ish node of an input schema with a readable path: `cases`, `cases[]`, `cases[].changes`. */
function schemaNodes(schema: unknown): SchemaNode[] {
  if (!isRecord(schema)) return [];
  const out: SchemaNode[] = [{ path: '', schema, kind: 'root' }];
  const walk = (s: Schema, prefix: string) => {
    for (const [name, p] of Object.entries(props(s))) {
      if (!isRecord(p)) continue;
      const path = prefix === '' ? name : `${prefix}.${name}`;
      out.push({ path, schema: p, kind: 'param' });
      walk(p, path);
      if (isRecord(p.items)) {
        out.push({ path: `${path}[]`, schema: p.items, kind: 'items' });
        walk(p.items, `${path}[]`);
      }
    }
  };
  walk(schema, '');
  return out;
}

/** The parameters at the top of the input schema. */
const topParams = (tool: ListedTool) =>
  Object.entries(props(tool.inputSchema)).filter((e): e is [string, Schema] => isRecord(e[1]));

/** Lower-case words of an identifier: `getUser_v2` → get, user, v2. */
function identifierWords(name: string): string[] {
  return name
    .replace(/([a-z\d])([A-Z])/g, (_m, a: string, b: string) => `${a} ${b}`)
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter((w) => w !== '');
}

/** Name words without the first word every tool of the server starts with (its prefix), which says nothing about the tool. */
function distinctiveNameWords(tools: readonly ListedTool[]): Map<ListedTool, Set<string>> {
  const words = new Map(tools.map((t) => [t, identifierWords(t.name)]));
  const all = [...words.values()];
  const first = all[0]?.[0];
  const prefixed = all.length > 1 && first !== undefined && all.every((ws) => ws[0] === first);
  return new Map([...words].map(([t, ws]) => [t, new Set(prefixed ? ws.slice(1) : ws)]));
}

function descriptionWords(description: string): Set<string> {
  return new Set(
    description
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= T.similarity.minWordLength),
  );
}

/** Jaccard overlap of two word sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

const normalize = (s: string) => s.toLowerCase().replace(/[’ʼ]/g, "'");

/**
 * The listed language a text is written in, or undefined: the alphabet that dominates, then the language of that
 * alphabet whose stop words occur most (and, for a language with letters of its own, which has them).
 */
export function detectLanguage(value: string): LanguageCode | undefined {
  const lower = normalize(value);
  const latin = lower.match(/\p{Script=Latin}/gu)?.length ?? 0;
  const cyrillic = lower.match(/\p{Script=Cyrillic}/gu)?.length ?? 0;
  if (latin === 0 && cyrillic === 0) return undefined;
  const script = cyrillic > latin ? 'Cyrillic' : 'Latin';
  const words = lower.split(/[^\p{L}']+/u);
  let best: { code: LanguageCode; hits: number } | undefined;
  for (const [code, lang] of Object.entries(T.languages) as [LanguageCode, (typeof T.languages)[LanguageCode]][]) {
    if (lang.script !== script) continue;
    if (lang.letters !== '' && ![...lang.letters].some((l) => lower.includes(l))) continue;
    const stopwords: readonly string[] = lang.stopwords;
    const hits = words.filter((w) => stopwords.includes(w)).length;
    if (hits >= T.language.minStopwords && (best === undefined || hits > best.hits)) best = { code, hits };
  }
  return best?.code;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a phrase of the list starts a word of the text. */
function hasPhrase(value: string, phrases: readonly string[]): boolean {
  const lower = normalize(value);
  return phrases.some((p) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(p)}`, 'u').test(lower));
}

/**
 * Whether the text uses a phrase of the given word list in its own language: true or false when the language is
 * listed, undefined when it is not — a word rule then stays silent.
 */
function saysInOwnLanguage(value: string, list: 'whenNot' | 'example' | 'closedSet'): boolean | undefined {
  const lang = detectLanguage(value);
  return lang === undefined ? undefined : hasPhrase(value, T.languages[lang][list]);
}

type NameStyle = 'snake_case' | 'camelCase' | 'kebab-case' | 'PascalCase' | 'dot.case' | 'mixed';

function nameStyle(name: string): NameStyle {
  if (/^[a-z\d]+(_[a-z\d]+)*$/.test(name)) return 'snake_case';
  if (/^[a-z][a-z\d]*([A-Z][a-z\d]*)+$/.test(name)) return 'camelCase';
  if (/^[a-z\d]+(-[a-z\d]+)+$/.test(name)) return 'kebab-case';
  if (/^([A-Z][a-z\d]*)+$/.test(name)) return 'PascalCase';
  if (/^[a-z\d_]+(\.[a-z\d_]+)+$/.test(name)) return 'dot.case';
  return 'mixed';
}

/** The style more than `majorityShare` of the server's tools use, if any. */
function majorityStyle(tools: readonly ListedTool[]): NameStyle | undefined {
  const counts = new Map<NameStyle, number>();
  for (const t of tools) counts.set(nameStyle(t.name), (counts.get(nameStyle(t.name)) ?? 0) + 1);
  for (const [style, n] of counts) if (n / tools.length > T.names.majorityShare) return style;
  return undefined;
}

const nameHas = (tool: ListedTool, words: readonly string[]) => identifierWords(tool.name).some((w) => words.includes(w));

function isFreeObject(s: Schema): boolean {
  return schemaTypes(s).has('object') && Object.keys(props(s)).length === 0 && s.additionalProperties !== false;
}

const pairs = <X>(xs: readonly X[]): [X, X][] => xs.flatMap((a, i) => xs.slice(i + 1).map((b): [X, X] => [a, b]));

/** Tools similar enough to `tool` that a model may pick the wrong one. */
function similarTools(tools: readonly ListedTool[], nameThreshold: number, descThreshold: number) {
  const names = distinctiveNameWords(tools);
  // Each description split once, not once per pair: the split costs more than the comparison.
  const descriptions = new Map(tools.map((t) => [t, descriptionWords(text(t.description) ?? '')]));
  return (a: ListedTool, b: ListedTool) => {
    const byName = overlap(names.get(a) ?? new Set(), names.get(b) ?? new Set());
    // A tool without a description has no words, so its overlap is 0, as it was when the pair was skipped.
    const byDescription = overlap(descriptions.get(a) ?? new Set(), descriptions.get(b) ?? new Set());
    return { byName, byDescription, similar: byName >= nameThreshold || byDescription >= descThreshold };
  };
}

/**
 * A rule that compares every pair of tools, over a list longer than `similarity.maxTools`: one `could-not-run` hit
 * instead of a run that would not end. The target names no tool, since the rule judged none.
 */
function tooManyToPair(tools: readonly ListedTool[]): RuleHit[] | undefined {
  const limit = T.similarity.maxTools;
  if (tools.length <= limit) return undefined;
  return [
    {
      target: { tool: '' },
      message: `too many tools to compare pairwise (${tools.length}, limit ${limit})`,
      expected: `at most ${limit} tools`,
      actual: `${tools.length} tools`,
      state: 'could-not-run',
    },
  ];
}

const tool = (t: ListedTool, param?: string): LintTarget => (param === undefined ? { tool: t.name } : { tool: t.name, param });

export const LINT_RULES: readonly LintRule[] = [
  {
    id: 'input-schema-not-object',
    description: 'The input schema is missing or its root is not of type "object".',
    class: 'deterministic',
    level: 'error',
    fix: 'Give the tool an inputSchema whose root has "type": "object" (a tool without parameters: {"type": "object", "additionalProperties": false}).',
    specRef: `${SCHEMA}#tool-inputschema`,
    check: (tools) =>
      tools
        .filter((t) => !isRecord(t.inputSchema) || t.inputSchema.type !== 'object')
        .map((t) => ({
          target: tool(t),
          message: 'The input schema is not a JSON Schema object of type "object".',
          expected: 'inputSchema.type = "object"',
          actual: isRecord(t.inputSchema) ? `inputSchema.type = ${JSON.stringify(t.inputSchema.type)}` : `inputSchema = ${JSON.stringify(t.inputSchema)}`,
        })),
  },
  {
    id: 'output-schema-not-object',
    description: 'The output schema is given, but its root is not of type "object".',
    class: 'deterministic',
    level: 'error',
    fix: 'Make the output schema an object at the root ("type": "object") and return the result inside it, or leave outputSchema out.',
    specRef: `${SCHEMA}#tool-outputschema`,
    check: (tools) =>
      tools
        .filter((t) => t.outputSchema !== undefined && (!isRecord(t.outputSchema) || t.outputSchema.type !== 'object'))
        .map((t) => ({
          target: tool(t),
          message: 'The output schema is not of type "object" at the root.',
          expected: 'outputSchema.type = "object"',
          actual: isRecord(t.outputSchema) ? `outputSchema.type = ${JSON.stringify(t.outputSchema.type)}` : `outputSchema = ${JSON.stringify(t.outputSchema)}`,
        })),
  },
  {
    id: 'required-unknown-property',
    description: '"required" names a property a closed schema does not define, so no call can satisfy it.',
    class: 'deterministic',
    level: 'error',
    fix: 'Remove the name from "required", or add the property it names to "properties".',
    specRef: `${SCHEMA}#tool-inputschema`,
    check: (tools) =>
      tools.flatMap((t) =>
        schemaNodes(t.inputSchema).flatMap((node) => {
          const required = node.schema.required;
          // An open schema can still satisfy "required" through additionalProperties or composition: not judged here,
          // a candidate for a heuristic rule. Only a closed node makes the name unsatisfiable.
          if (!Array.isArray(required) || !isClosed(node.schema)) return [];
          const known = props(node.schema);
          return required
            .filter((r): r is string => typeof r === 'string' && !(r in known))
            .map((r) => ({
              target: tool(t, node.path === '' ? r : `${node.path}.${r}`),
              message: `"required" names "${r}", which the schema does not define, so no call can satisfy it.`,
              expected: `"${r}" among the properties`,
              actual: `properties: ${Object.keys(known).join(', ') || 'none'}`,
            }));
        }),
      ),
  },
  {
    // An error although the specification says SHOULD: tools/call finds a tool by name alone, so a duplicate is unreachable.
    id: 'name-duplicate',
    description: 'Two tools share a name, so only one of them can be called.',
    class: 'deterministic',
    level: 'error',
    fix: 'Give each tool its own name; tools/call picks a tool by name alone, so a second tool of the same name cannot be called.',
    specRef: `${TOOLS_PAGE}#tool-names`,
    check: (tools) => {
      const seen = new Set<string>();
      const hits: RuleHit[] = [];
      for (const t of tools) {
        if (seen.has(t.name)) {
          hits.push({ target: tool(t), message: `Two tools are named "${t.name}".`, expected: 'unique tool names', actual: `"${t.name}" more than once` });
        }
        seen.add(t.name);
      }
      return hits;
    },
  },
  {
    // The specification words its name rules as SHOULD, so a name outside them is a warning, not an error.
    id: 'name-invalid',
    description: 'The name uses characters or a length outside what the specification recommends.',
    class: 'deterministic',
    level: 'warn',
    fix: 'Use only ASCII letters, digits, underscore, hyphen and dot in the name, within the length the specification gives.',
    specRef: `${TOOLS_PAGE}#tool-names`,
    check: (tools) =>
      tools
        .filter((t) => t.name.length === 0 || t.name.length > T.names.maxLength || /[^A-Za-z\d_.-]/.test(t.name))
        .map((t) => ({
          target: tool(t),
          message: `The name "${t.name}" is outside the characters or length the specification recommends.`,
          expected: `[A-Za-z0-9_.-], ${T.names.maxLength} characters at most`,
          actual: `"${t.name}" (${t.name.length} characters)`,
        })),
  },
  {
    // Absence is a fact, not a guess: deterministic. The specification makes a description optional, so this is quality
    // advice at warning level, not a violation of the specification; specRef points at the optional field itself.
    id: 'desc-missing',
    description: 'The tool has no description to choose it by.',
    class: 'deterministic',
    level: 'warn',
    fix: 'Describe what the tool does, when to use it and when not to: the model chooses tools by name and description alone. The specification does not require a description; this is advice on quality.',
    specRef: `${SCHEMA}#tool-description`,
    check: (tools) =>
      tools
        .filter((t) => text(t.description) === undefined)
        .map((t) => ({ target: tool(t), message: 'The tool has no description.', expected: 'a description', actual: 'none' })),
  },
  {
    id: 'desc-short',
    description: 'The description is too short to tell when to choose the tool.',
    class: 'heuristic',
    level: 'info',
    fix: 'Say in a sentence or two what the tool does and what it returns.',
    specRef: '',
    check: (tools) =>
      tools.flatMap((t) => {
        const d = text(t.description);
        if (d === undefined || d.trim().length >= T.description.minLength) return [];
        return [
          {
            target: tool(t),
            message: 'The description is too short for a model to tell when to choose the tool.',
            expected: `at least ${T.description.minLength} characters`,
            actual: `${d.trim().length} characters`,
          },
        ];
      }),
  },
  {
    id: 'desc-long',
    description: 'The description is long enough to cost every request.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Shorten the description to what a model needs to choose the tool; move reference detail into parameter descriptions.',
    specRef: '',
    check: (tools) =>
      tools.flatMap((t) => {
        const d = text(t.description);
        if (d === undefined || d.length <= T.description.maxLength) return [];
        return [
          {
            target: tool(t),
            message: 'The description is long: it is sent with every request.',
            expected: `at most ${T.description.maxLength} characters`,
            actual: `${d.length} characters`,
          },
        ];
      }),
  },
  {
    id: 'desc-no-when-not',
    description: 'The description does not say when not to use the tool (a warning when a similar tool exists).',
    class: 'heuristic',
    level: 'info',
    fix: 'Add when not to use the tool and what to use instead ("Do not use for …; use … instead").',
    specRef: '',
    check: (tools) => {
      const tooMany = tooManyToPair(tools);
      if (tooMany !== undefined) return tooMany;
      const similar = similarTools(tools, T.similarity.names, T.similarity.related);
      return tools.flatMap((t) => {
        const d = text(t.description);
        if (d === undefined || saysInOwnLanguage(d, 'whenNot') !== false) return [];
        const neighbour = tools.find((o) => o !== t && similar(t, o).similar);
        return [
          {
            target: tool(t),
            message:
              neighbour === undefined
                ? 'The description does not say when not to use the tool.'
                : `The description does not say when not to use the tool, and "${neighbour.name}" is similar to it.`,
            expected: 'a "when not to use" clause',
            actual: 'none found',
            ...(neighbour === undefined ? {} : { level: 'warn' as const }),
          },
        ];
      });
    },
  },
  {
    id: 'tools-similar',
    description: 'Two tools have names or descriptions too alike to tell apart.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Make the names and descriptions of the two tools say how they differ, or merge them.',
    specRef: '',
    check: (tools) => {
      const tooMany = tooManyToPair(tools);
      if (tooMany !== undefined) return tooMany;
      const similar = similarTools(tools, T.similarity.names, T.similarity.descriptions);
      return pairs(tools).flatMap(([a, b]) => {
        const s = similar(a, b);
        if (!s.similar) return [];
        return [
          {
            target: tool(a),
            message: `"${a.name}" and "${b.name}" are hard to tell apart.`,
            expected: `name overlap below ${T.similarity.names}, description overlap below ${T.similarity.descriptions}`,
            actual: `name ${s.byName.toFixed(T.similarity.decimals)}, description ${s.byDescription.toFixed(T.similarity.decimals)}`,
          },
        ];
      });
    },
  },
  {
    id: 'param-enum-in-text',
    description: 'A string parameter lists its allowed values in the description instead of an enum.',
    class: 'heuristic',
    level: 'warn',
    fix: 'List the allowed values in "enum" rather than in the description, so the client can check them.',
    specRef: '',
    check: (tools) =>
      tools.flatMap((t) =>
        topParams(t).flatMap(([name, p]) => {
          const d = text(p.description);
          if (d === undefined || !schemaTypes(p).has('string') || hasClosedSet(p) || saysInOwnLanguage(d, 'closedSet') !== true) return [];
          return [
            {
              target: tool(t, name),
              message: 'The parameter description lists a closed set of values, but the schema does not.',
              expected: 'an enum',
              actual: `a free string described as "${d}"`,
            },
          ];
        }),
      ),
  },
  {
    id: 'param-type-by-name',
    description: 'A parameter named like a number, flag, date or URL is a free string.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Give the parameter the type its name promises (number, boolean), or a "format" (date-time, uri).',
    specRef: '',
    check: (tools) =>
      tools.flatMap((t) =>
        topParams(t).flatMap(([name, p]) => {
          const types = schemaTypes(p);
          types.delete('null');
          if (types.size !== 1 || !types.has('string') || hasClosedSet(p) || p.format !== undefined) return [];
          const words = identifierWords(name);
          const kinds = T.typedParamWords;
          const kind =
            (Object.keys(kinds) as (keyof typeof kinds)[]).find((k) => {
              const list: readonly string[] = kinds[k];
              return k === 'boolean' ? list.includes(words[0] ?? '') : words.some((w) => list.includes(w));
            });
          if (kind === undefined) return [];
          return [
            {
              target: tool(t, name),
              message: `The name "${name}" suggests a ${kind}, but the parameter is a free string.`,
              expected: `a ${kind} type or format`,
              actual: 'type string, no format',
            },
          ];
        }),
      ),
  },
  {
    id: 'param-desc-missing',
    description: 'A parameter has no description.',
    class: 'heuristic',
    level: 'info',
    fix: 'Describe the parameter: what it means, its unit or format, and what happens when it is left out.',
    specRef: '',
    check: (tools) =>
      tools.flatMap((t) =>
        topParams(t)
          .filter(([, p]) => text(p.description) === undefined)
          .map(([name]) => ({ target: tool(t, name), message: 'The parameter has no description.', expected: 'a description', actual: 'none' })),
      ),
  },
  {
    id: 'param-example-missing',
    description: 'A free-form object parameter has no example of its keys.',
    class: 'heuristic',
    level: 'info',
    fix: 'Show the shape of a free-form object: add "examples" to the schema, or an example in the description.',
    specRef: '',
    check: (tools) =>
      tools.flatMap((t) =>
        schemaNodes(t.inputSchema)
          .filter((n) => n.kind === 'param')
          .flatMap((n) => {
            const p = n.schema;
            const free = isFreeObject(p) || (isRecord(p.items) && isFreeObject(p.items));
            if (!free || p.examples !== undefined || p.default !== undefined) return [];
            const d = text(p.description);
            if (d !== undefined && saysInOwnLanguage(d, 'example') !== false) return [];
            return [
              {
                target: tool(t, n.path),
                message: 'A free-form object parameter without an example: the model has to guess its keys.',
                expected: 'examples, or an example in the description',
                actual: 'none',
              },
            ];
          }),
      ),
  },
  {
    id: 'required-missing',
    description: 'The input schema has parameters but no "required" list.',
    class: 'heuristic',
    level: 'info',
    fix: 'Add "required" with the parameters a call cannot do without (an empty list if every one is optional).',
    specRef: '',
    check: (tools) =>
      tools
        .filter((t) => isRecord(t.inputSchema) && topParams(t).length > 0 && !Array.isArray(t.inputSchema.required))
        .map((t) => ({
          target: tool(t),
          message: 'The input schema has parameters but no "required" list, so a model cannot tell which it must send.',
          expected: 'a "required" list',
          actual: 'none',
        })),
  },
  {
    id: 'name-style-mismatch',
    description: 'The name does not follow the naming style of the other tools.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Name the tool in the style the other tools of the server use.',
    specRef: '',
    check: (tools) => {
      const majority = majorityStyle(tools);
      if (majority === undefined) return [];
      return tools
        .filter((t) => nameStyle(t.name) !== majority)
        .map((t) => ({
          target: tool(t),
          message: `"${t.name}" does not follow the naming style of the other tools.`,
          expected: majority,
          actual: nameStyle(t.name),
        }));
    },
  },
  {
    id: 'name-not-snake',
    description: 'The name is not snake_case.',
    class: 'heuristic',
    level: 'info',
    fix: 'Prefer snake_case names: the most common style among MCP servers.',
    specRef: '',
    check: (tools) => {
      const majority = majorityStyle(tools);
      return tools
        .filter((t) => nameStyle(t.name) !== 'snake_case' && (majority === undefined || nameStyle(t.name) === majority))
        .map((t) => ({ target: tool(t), message: `"${t.name}" is not snake_case.`, expected: 'snake_case', actual: nameStyle(t.name) }));
    },
  },
  {
    id: 'annotations-missing',
    description: 'The tool has no annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint).',
    class: 'deterministic',
    level: 'info',
    fix: 'Add annotations: readOnlyHint, destructiveHint, idempotentHint and openWorldHint tell a client what the tool may do.',
    specRef: `${SCHEMA}#tool-annotations`,
    check: (tools) =>
      tools
        .filter((t) => !isRecord(t.annotations))
        .map((t) => ({ target: tool(t), message: 'The tool has no annotations.', expected: 'annotations', actual: 'none' })),
  },
  {
    id: 'hint-readonly-writes',
    description: 'The tool is marked read-only, but its name says it changes something.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Set readOnlyHint to false if the tool changes anything, or rename it if it does not.',
    specRef: `${SCHEMA}#toolannotations-readonlyhint`,
    check: (tools) =>
      tools
        .filter((t) => t.annotations?.readOnlyHint === true && nameHas(t, T.writeVerbs))
        .map((t) => ({
          target: tool(t),
          message: `"${t.name}" is marked read-only, but its name says it changes something.`,
          expected: 'readOnlyHint: false',
          actual: 'readOnlyHint: true',
        })),
  },
  {
    id: 'hint-destructive-understated',
    description: 'The tool says its updates are additive, but its name says it overwrites or removes.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Set destructiveHint to true (the default) for a tool that overwrites or removes; false promises additive updates only.',
    specRef: `${SCHEMA}#toolannotations-destructivehint`,
    check: (tools) =>
      tools
        .filter((t) => t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint === false && nameHas(t, T.overwriteVerbs))
        .map((t) => ({
          target: tool(t),
          message: `"${t.name}" overwrites or removes by its name, but says its updates are additive only.`,
          expected: 'destructiveHint: true',
          actual: 'destructiveHint: false',
        })),
  },
  {
    id: 'hint-idempotent-missing',
    description: 'A tool that changes things does not say whether repeating a call is safe.',
    class: 'heuristic',
    level: 'info',
    fix: 'Say whether repeating the same call changes anything more: set idempotentHint.',
    specRef: `${SCHEMA}#toolannotations-idempotenthint`,
    check: (tools) =>
      tools
        .filter((t) => isRecord(t.annotations) && t.annotations.readOnlyHint !== true && t.annotations.idempotentHint === undefined)
        .map((t) => ({ target: tool(t), message: 'A tool that changes things does not say whether a repeated call is safe.', expected: 'idempotentHint', actual: 'not set' })),
  },
  {
    id: 'list-no-paging',
    description: 'A tool that returns a list by its name cannot be asked for less.',
    class: 'heuristic',
    level: 'warn',
    fix: 'Let the caller bound the answer: add a limit and a cursor (or page) parameter.',
    specRef: '',
    check: (tools) =>
      tools
        .filter((t) => nameHas(t, T.listVerbs))
        .filter((t) => {
          const paging: readonly string[] = T.pagingParams;
          return !Object.keys(props(t.inputSchema)).some((p) => paging.includes(p.toLowerCase()));
        })
        .map((t) => ({
          target: tool(t),
          message: `"${t.name}" returns a list by its name, but cannot be asked for less.`,
          expected: `one of: ${T.pagingParams.join(', ')}`,
          actual: `parameters: ${Object.keys(props(t.inputSchema)).join(', ') || 'none'}`,
        })),
  },
  {
    id: 'list-size',
    description: 'The whole tool list costs more tokens on every request than the limit.',
    class: 'measure',
    level: 'warn',
    fix: 'Shorten the biggest tools first (descriptions, nested schemas), or hide rarely used tools behind discovery.',
    specRef: '',
    check: (tools) => {
      const size = toolListSize(tools);
      if (size.totalTokens <= T.size.maxListTokens || size.largest === undefined) return [];
      return [
        {
          target: { tool: size.largest.name },
          message: `The tool list costs about ${size.totalTokens} tokens on every request; the biggest tool is "${size.largest.name}" (${size.largest.tokens}).`,
          expected: `at most ${T.size.maxListTokens} tokens`,
          actual: `${size.totalTokens} tokens (${size.method})`,
        },
      ];
    },
  },
];
