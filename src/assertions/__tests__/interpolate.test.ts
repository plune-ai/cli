import { describe, expect, it } from 'vitest';
import { interpolate } from '../interpolate.js';

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
