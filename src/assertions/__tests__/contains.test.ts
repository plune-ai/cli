import { describe, expect, it } from 'vitest';
import { contains, containsAny, containsAll } from '../contains.js';
import type {
  ContainsAssertion,
  ContainsAnyAssertion,
  ContainsAllAssertion,
} from '../../types/config.js';
import type { AssertionContext } from '../../types/assertion.js';

function base(output: string, expected?: string) {
  return {
    output,
    vars: {} as Record<string, unknown>,
    row: { vars: {}, ...(expected !== undefined ? { expected } : {}) },
  };
}

describe('contains', () => {
  const run = (output: string, params: Omit<ContainsAssertion, 'type'>, expected?: string) =>
    contains.run({
      ...base(output, expected),
      params: { type: 'contains', ...params },
    } as AssertionContext<ContainsAssertion>);

  it('passes when output contains the substring (AC-4)', async () => {
    expect((await run('hello world', { value: 'world' })).passed).toBe(true);
  });

  it('fails with a reason when absent', async () => {
    const r = await run('hello', { value: 'world' });
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('respects ignore_case', async () => {
    expect((await run('Hello', { value: 'hello', ignore_case: true })).passed).toBe(true);
    expect((await run('Hello', { value: 'hello' })).passed).toBe(false);
  });

  it('interpolates {{expected}} (AC-8)', async () => {
    expect((await run('the answer is 42!', { value: '{{expected}}' }, '42')).passed).toBe(true);
  });
});

describe('contains-any / contains-all (AC-5)', () => {
  const anyRun = (output: string, values: string[]) =>
    containsAny.run({
      ...base(output),
      params: { type: 'contains-any', values },
    } as AssertionContext<ContainsAnyAssertion>);
  const allRun = (output: string, values: string[]) =>
    containsAll.run({
      ...base(output),
      params: { type: 'contains-all', values },
    } as AssertionContext<ContainsAllAssertion>);

  it('contains-any passes on at least one match', async () => {
    expect((await anyRun('has a only', ['a', 'b'])).passed).toBe(true);
  });

  it('contains-any fails on no match', async () => {
    const r = await anyRun('none here', ['a', 'b']);
    expect(r.passed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it('contains-all passes only when all present', async () => {
    expect((await allRun('a and b', ['a', 'b'])).passed).toBe(true);
  });

  it('contains-all fails listing the missing values', async () => {
    const r = await allRun('a only', ['a', 'b']);
    expect(r.passed).toBe(false);
    expect(r.reason).toContain('b');
  });
});
