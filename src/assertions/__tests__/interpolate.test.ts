import { describe, expect, it } from 'vitest';
import { interpolate, usesExpected } from '../interpolate.js';

function ctx(vars: Record<string, unknown>, expected?: string) {
  return { vars, row: { vars: vars as Record<string, string | number | boolean>, ...(expected !== undefined ? { expected } : {}) } };
}

describe('interpolate (ADR-AP03)', () => {
  it('substitutes {{expected}} from row.expected', () => {
    expect(interpolate('{{expected}}', ctx({}, '42'))).toBe('42');
  });

  it('substitutes {{vars.X}} from ctx.vars', () => {
    expect(interpolate('Hello {{vars.name}}', ctx({ name: 'Alice' }))).toBe('Hello Alice');
  });

  it('stringifies non-string vars', () => {
    expect(interpolate('{{vars.n}}', ctx({ n: 7 }))).toBe('7');
  });

  it('renders {{expected}} as empty string when expected is absent', () => {
    expect(interpolate('[{{expected}}]', ctx({}))).toBe('[]');
  });

  it('leaves an unknown {{placeholder}} as a literal', () => {
    expect(interpolate('{{foo}}', ctx({}))).toBe('{{foo}}');
  });

  it('leaves {{vars.X}} literal when the var is absent', () => {
    expect(interpolate('{{vars.missing}}', ctx({}))).toBe('{{vars.missing}}');
  });

  it('trims whitespace inside the braces', () => {
    expect(interpolate('{{  expected  }}', ctx({}, 'ok'))).toBe('ok');
  });

  it('resolves multiple placeholders in one string', () => {
    expect(interpolate('{{vars.a}}-{{expected}}', ctx({ a: 'x' }, 'y'))).toBe('x-y');
  });

  it('returns the string unchanged when there are no placeholders', () => {
    expect(interpolate('plain text', ctx({}, 'z'))).toBe('plain text');
  });
});

describe('usesExpected', () => {
  it('is true for a string with {{expected}}, with or without spaces in the braces', () => {
    expect(usesExpected('{{expected}}')).toBe(true);
    expect(usesExpected('{{ expected }}')).toBe(true);
    expect(usesExpected('the answer is {{expected}}!')).toBe(true);
  });

  it('is false for a string without it, including other placeholders', () => {
    expect(usesExpected('plain')).toBe(false);
    expect(usesExpected('{{vars.expected}}')).toBe(false);
    expect(usesExpected('')).toBe(false);
  });

  it('looks inside arrays and nested objects', () => {
    expect(usesExpected(['a', '{{expected}}'])).toBe(true);
    expect(usesExpected(['a', 'b'])).toBe(false);
    expect(usesExpected({ type: 'contains', value: '{{expected}}' })).toBe(true);
    expect(usesExpected({ args: { deep: [{ x: '{{expected}}' }] } })).toBe(true);
    expect(usesExpected({ args: { deep: [{ x: 'no' }] } })).toBe(false);
  });

  it('is false for non-string values and an empty object', () => {
    expect(usesExpected(7)).toBe(false);
    expect(usesExpected(true)).toBe(false);
    expect(usesExpected(null)).toBe(false);
    expect(usesExpected(undefined)).toBe(false);
    expect(usesExpected({})).toBe(false);
    expect(usesExpected([])).toBe(false);
  });
});
