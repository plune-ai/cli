import { describe, expect, it } from 'vitest';
import { parseDuration } from '../duration.js';

describe('parseDuration', () => {
  it('reads units and bare milliseconds', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('12h')).toBe(43_200_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('250')).toBe(250);
  });
  it('rejects nonsense and zero', () => {
    for (const bad of ['', 'soon', '-5m', '0s', '5w']) {
      expect(() => parseDuration(bad)).toThrow(/Invalid duration/);
    }
  });
});
