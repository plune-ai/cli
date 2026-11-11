/**
 * A JSON Schema judged in its own dialect: `$schema` when it names one, else 2020-12, the default of the
 * specification (basic/index, JSON Schema Usage). A dialect this checker has no validator for is said so, never
 * guessed at. Nothing is fetched: a `$ref` to another document does not resolve, and such a schema is not valid here.
 */

import { Ajv } from 'ajv';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { Ajv2020 } from 'ajv/dist/2020.js';

// Unknown keywords are allowed (2020-12 keeps them as annotations); formats are not asserted.
const OPTIONS = { strict: false, validateFormats: false, logger: false } as const;

type Validator = Ajv | Ajv2019 | Ajv2020;
const DIALECTS: readonly [RegExp, () => Validator][] = [
  [/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/, () => new Ajv2020(OPTIONS)],
  [/^https?:\/\/json-schema\.org\/draft\/2019-09\/schema#?$/, () => new Ajv2019(OPTIONS)],
  [/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/, () => new Ajv(OPTIONS)],
];
export const DIALECT_NAMES = '2020-12, 2019-09 and draft-07';

export type Judged =
  | { valid: true; check: (value: unknown) => string | undefined }
  | { valid: false; problem: string }
  | { valid: 'unsupported'; dialect: string };

const firstLine = (text: string) => text.split('\n')[0] ?? text;

export function judge(schema: Record<string, unknown>): Judged {
  const declared = schema['$schema'];
  if (declared !== undefined && typeof declared !== 'string') return { valid: false, problem: '$schema is not a string' };
  const make = declared === undefined ? DIALECTS[0]?.[1] : DIALECTS.find(([re]) => re.test(declared))?.[1];
  if (make === undefined) return { valid: 'unsupported', dialect: String(declared) };
  // One validator per schema: two schemas with the same $id must not meet.
  const ajv = make();
  try {
    if (!ajv.validateSchema(schema)) return { valid: false, problem: ajv.errorsText(ajv.errors) };
    const fn = ajv.compile(schema);
    return { valid: true, check: (value) => (fn(value) ? undefined : ajv.errorsText(fn.errors)) };
  } catch (err) {
    return { valid: false, problem: firstLine((err as Error).message) };
  }
}
