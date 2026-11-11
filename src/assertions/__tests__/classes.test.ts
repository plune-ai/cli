import { describe, expect, it } from 'vitest';
import { ASSERTION_CLASSES } from '../classes.js';
import { createDefaultRegistry } from '../registry.js';
import { assertionConfigSchema } from '../../config/schema.js';
import type { AssertionConfig } from '../../types/config.js';

/** One valid example of each tool-call assertion. */
const TOOL_CALL_EXAMPLES: AssertionConfig[] = [
  { type: 'tool-called', tool: 'search', min_count: 1 },
  { type: 'tool-not-called', tool: 'delete' },
  { type: 'tool-args', tool: 'search', args: { q: 'x' }, match: 'partial', min_count: 1 },
  { type: 'tool-order', tools: ['search', 'read'], strict: false },
  { type: 'only-tools', tools: [] },
  { type: 'first-tool', tool: 'search' },
  { type: 'no-tool-errors' },
  { type: 'tool-call-count', min: 1, max: 3 },
  { type: 'no-repeated-call', tool: 'search' },
  { type: 'token-budget', max: 5000 },
  { type: 'tool-latency', max_ms: 2000 },
  { type: 'tool-result-size', max_bytes: 65536, tool: 'read' },
  { type: 'tool-result-schema', schema: { type: 'object' } },
  { type: 'no-destructive-tool' },
];

describe('CLI · assertions · classes', () => {
  it('CLI · assertions · classes · every registered type has a class, and every class a registered type (AC-1)', () => {
    const registered = createDefaultRegistry().types();
    expect([...registered].sort()).toEqual(Object.keys(ASSERTION_CLASSES).sort());
  });

  it('CLI · assertions · classes · a type registered without a class is caught (AC-1)', () => {
    const registry = createDefaultRegistry();
    registry.register('tool-new', { run: () => Promise.resolve({ passed: true }) });
    const unclassed = registry.types().filter((t) => !(t in ASSERTION_CLASSES));
    expect(unclassed).toEqual(['tool-new']);
  });

  it('CLI · assertions · classes · the 14 tool-call types pass the schema with their classes (AC-1)', () => {
    expect(new Set(TOOL_CALL_EXAMPLES.map((a) => a.type)).size).toBe(14);
    for (const a of TOOL_CALL_EXAMPLES) {
      expect(assertionConfigSchema.safeParse(a).success, a.type).toBe(true);
      expect(ASSERTION_CLASSES[a.type], a.type).toMatch(/^(measure|deterministic|heuristic)$/);
    }
    expect(ASSERTION_CLASSES['no-repeated-call']).toBe('heuristic');
    expect(
      Object.entries(ASSERTION_CLASSES)
        .filter(([, c]) => c === 'heuristic')
        .map(([t]) => t),
    ).toEqual(['no-repeated-call']);
    for (const t of [
      'tool-call-count',
      'token-budget',
      'tool-latency',
      'tool-result-size',
    ] as const)
      expect(ASSERTION_CLASSES[t]).toBe('measure');
  });

  it('CLI · assertions · classes · the schema refuses what a check could not measure', () => {
    const bad = [
      { type: 'tool-call-count' },
      { type: 'tool-call-count', min: 3, max: 1 },
      { type: 'tool-called', tool: '' },
      { type: 'tool-called', tool: 'x', min_count: 0 },
      { type: 'tool-args', tool: 'x', args: {}, match: 'fuzzy' },
      { type: 'tool-order', tools: [] },
      { type: 'token-budget', max: 0 },
      { type: 'tool-latency', max_ms: -1 },
      { type: 'tool-result-size', max_bytes: 1.5 },
    ];
    for (const a of bad)
      expect(assertionConfigSchema.safeParse(a).success, JSON.stringify(a)).toBe(false);
    expect(assertionConfigSchema.safeParse({ type: 'tool-call-count', max: 0 }).success).toBe(true);
  });
});
