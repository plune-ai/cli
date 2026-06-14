import { describe, expect, it } from 'vitest';
import { createStyler } from '../style.js';
import { truncate } from '../helpers.js';

describe('createStyler', () => {
  it('wraps text in ANSI when color is on', () => {
    const s = createStyler(true);
    expect(s.green('ok')).toContain('['); // contains an ANSI escape
    expect(s.green('ok')).toContain('ok');
  });

  it('is identity (no ANSI) when color is off (AC-2)', () => {
    const s = createStyler(false);
    expect(s.green('ok')).toBe('ok');
    expect(s.red('x')).toBe('x');
    expect(s.yellow('x')).toBe('x');
    expect(s.dim('x')).toBe('x');
    expect(s.bold('x')).toBe('x');
  });
});

describe('truncate', () => {
  it('leaves short strings unchanged', () => {
    expect(truncate('short', 100)).toBe('short');
  });

  it('truncates long strings with a suffix', () => {
    const out = truncate('a'.repeat(50), 10);
    expect(out.startsWith('a'.repeat(10))).toBe(true);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(50);
  });
});
