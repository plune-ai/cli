import { describe, expect, it } from 'vitest';
import { renderReport } from '../index.js';
import { mixed } from './fixtures.js';

describe('renderReport (dispatcher)', () => {
  it('dispatches to the json renderer', () => {
    expect(JSON.parse(renderReport(mixed, 'json'))).toEqual(mixed);
  });

  it('dispatches to the markdown renderer', () => {
    expect(renderReport(mixed, 'markdown')).toContain('| Metric | Value |');
  });

  it('dispatches to the console renderer', () => {
    const out = renderReport(mixed, 'console', { color: false });
    expect(out).toContain('e-fail');
    expect(out).toMatch(/passed/i);
  });
});
