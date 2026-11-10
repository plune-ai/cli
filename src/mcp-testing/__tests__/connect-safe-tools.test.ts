// Which tools of a foreign server may be called without asking: only the ones that say they read, do not say they
// destroy, and need no argument. Every other one comes back with the reason it was left out.

import { describe, expect, it } from 'vitest';
import { selectSafeTools } from '../connect/safe-tools.js';

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  inputSchema: { type: 'object' },
  ...extra,
});

describe('CLI · mcp connect · selectSafeTools', () => {
  const tools = [
    tool('read', { annotations: { readOnlyHint: true } }),
    tool('read-optional-arg', {
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: { q: {} } },
    }),
    tool('no-annotations'),
    tool('read-hint-false', { annotations: { readOnlyHint: false } }),
    tool('read-hint-string', { annotations: { readOnlyHint: 'true' } }),
    tool('read-but-destructive', { annotations: { readOnlyHint: true, destructiveHint: true } }),
    tool('read-required-arg', {
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', required: ['id'] },
    }),
    tool('write', { annotations: { readOnlyHint: false, destructiveHint: false } }),
  ];

  it('CLI · mcp connect · only read-only, non-destructive tools without a required argument are safe', () => {
    const { safe, skipped } = selectSafeTools(tools);
    expect(safe.map((t) => t.name)).toEqual(['read', 'read-optional-arg']);
    expect(Object.fromEntries(skipped.map((s) => [s.tool.name, s.reason]))).toEqual({
      'no-annotations': 'not-read-only',
      'read-hint-false': 'not-read-only',
      'read-hint-string': 'not-read-only',
      'read-but-destructive': 'destructive',
      'read-required-arg': 'required-arguments',
      write: 'not-read-only',
    });
  });

  // A tool that is not read-only is called only when it says `destructiveHint: false`: the protocol's own default is
  // destructive (ToolAnnotations.destructiveHint: «Default: true», meaningful when readOnlyHint is false).
  it('CLI · mcp connect · allowWrite lets a writing tool through only when it says it is not destructive', () => {
    const { safe, skipped } = selectSafeTools(tools, { allowWrite: true });
    expect(safe.map((t) => t.name)).toEqual(['read', 'read-optional-arg', 'write']);
    expect(skipped.map((s) => [s.tool.name, s.reason])).toEqual([
      ['no-annotations', 'no-destructive-hint'],
      ['read-hint-false', 'no-destructive-hint'],
      ['read-hint-string', 'no-destructive-hint'],
      ['read-but-destructive', 'destructive'],
      ['read-required-arg', 'required-arguments'],
    ]);
  });

  it('CLI · mcp connect · a tool that is not an object with a name is skipped, not thrown on', () => {
    const { safe, skipped } = selectSafeTools([null, 'x', { inputSchema: {} }] as unknown[]);
    expect(safe).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['malformed', 'malformed', 'malformed']);
  });

  it('CLI · mcp connect · an inputSchema.required that is not an array is malformed, not "no argument"', () => {
    const odd = (required: unknown) =>
      tool('odd', {
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', required },
      });
    const { safe, skipped } = selectSafeTools([odd('id'), odd({ 0: 'id' }), odd(null)]);
    expect(safe).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['malformed', 'malformed', 'malformed']);
  });
});
