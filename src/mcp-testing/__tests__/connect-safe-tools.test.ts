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

  // A tool that is not read-only is destructive unless it says `destructiveHint: false`: the protocol's own default
  // (ToolAnnotations.destructiveHint in the protocol schema: «Default: true», meaningful when readOnlyHint is false).
  it('CLI · mcp connect · allowWrite lets a writing tool through only when it says it is not destructive', () => {
    const { safe, skipped } = selectSafeTools(tools, { allowWrite: true });
    expect(safe.map((t) => t.name)).toEqual(['read', 'read-optional-arg', 'write']);
    expect(skipped.map((s) => [s.tool.name, s.reason])).toEqual([
      ['no-annotations', 'destructive'],
      ['read-hint-false', 'destructive'],
      ['read-hint-string', 'destructive'],
      ['read-but-destructive', 'destructive'],
      ['read-required-arg', 'required-arguments'],
    ]);
  });

  it('CLI · mcp connect · a tool that is not an object with a name is skipped, not thrown on', () => {
    const { safe, skipped } = selectSafeTools([null, 'x', { inputSchema: {} }] as unknown[]);
    expect(safe).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(['malformed', 'malformed', 'malformed']);
  });
});
