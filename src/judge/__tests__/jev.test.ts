import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JEV_BASE_URL,
  JEV_MAX_STATE_CHARS,
  jevState,
  makeJevJudge,
  resetJevWarning,
  warnJevExperimental,
} from '../jev.js';
import { AuthError, ProviderError } from '../../providers/errors.js';

const cfg = { type: 'jev' as const, model: 'jev-1.14.0' };
const answer = (p: number, tokens?: number) =>
  new Response(
    JSON.stringify({
      model: 'jev-1.14.0',
      answers: { q: { type: 'noul', noul: p } },
      ...(tokens !== undefined ? { usage: { input_tokens: tokens } } : {}),
    }),
    { status: 200 },
  );

function setup(replies: Array<Response | Error>, env: NodeJS.ProcessEnv = { TYPESAFE_API_KEY: 'key-1' }) {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const costs: number[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init! });
    const next = replies.shift();
    if (next === undefined) throw new Error('no reply left');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const judge = makeJevJudge(cfg, { env, fetchFn, onCost: (usd) => costs.push(usd) });
  return { judge, sent, costs };
}

const Q = { criteria: 'is correct', output: 'Paris', input: 'Capital of France?' };

describe('the experimental jev judge', () => {
  afterEach(() => resetJevWarning());

  it('shows the request, the answer and the criterion, and leaves the request out when there is none', () => {
    expect(jevState(Q)).toBe('Request:\nCapital of France?\n\nAnswer:\nParis\n\nCriterion:\nis correct');
    expect(jevState({ criteria: 'c', output: 'o' })).toBe('Answer:\no\n\nCriterion:\nc');
  });

  it('asks one yes-or-no question of the named model at the fixed address, with its own key', async () => {
    const { judge, sent, costs } = setup([answer(0.83, 1000)]);
    expect(await judge.decide!(Q)).toBe(0.83);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${JEV_BASE_URL}/v1/systemone`);
    expect((sent[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer key-1');
    expect(sent[0]!.init.redirect).toBe('error');
    const body = JSON.parse(sent[0]!.init.body as string) as { state: string; model: string; questions: { q: { type: string } } };
    expect(body.model).toBe('jev-1.14.0');
    expect(body.state).toBe(jevState(Q));
    expect(body.questions.q.type).toBe('noul');
    // 1000 input tokens at 0.042 USD a million.
    expect(costs).toHaveLength(1);
    expect(costs[0]).toBeCloseTo(0.000042, 12);
  });

  it('estimates the cost from the text when the answer names no usage', async () => {
    const { judge, costs } = setup([answer(0.5)]);
    await judge.decide!(Q);
    expect(costs[0]).toBeCloseTo((Math.ceil(jevState(Q).length / 3) / 1_000_000) * 0.042, 12);
  });

  it('sends nothing without a key, and says which variable is missing', async () => {
    const { judge, sent } = setup([], {});
    const err = await judge.decide!(Q).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).envVar).toBe('TYPESAFE_API_KEY');
    expect(sent).toEqual([]);
  });

  it('refuses a state over the limit before anything is sent, and never cuts it', async () => {
    const { judge, sent } = setup([]);
    const err = await judge.decide!({ criteria: 'c', output: 'x'.repeat(JEV_MAX_STATE_CHARS) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('JEV_INPUT_TOO_LONG');
    expect(sent).toEqual([]);
  });

  it('retries once on 429 and on 5xx, and no more', async () => {
    const once = setup([new Response('', { status: 429 }), answer(0.2, 10)]);
    expect(await once.judge.decide!(Q)).toBe(0.2);
    expect(once.sent).toHaveLength(2);

    const twice = setup([new Response('', { status: 503 }), new Response('', { status: 503 }), answer(0.2)]);
    await expect(twice.judge.decide!(Q)).rejects.toMatchObject({ code: 'JEV_HTTP' });
    expect(twice.sent).toHaveLength(2);
    expect(twice.costs).toEqual([]);
  });

  it('a refused key is an auth error and is not retried; another 4xx is an error of the row', async () => {
    const refused = setup([new Response('', { status: 401 })]);
    await expect(refused.judge.decide!(Q)).rejects.toBeInstanceOf(AuthError);
    expect(refused.sent).toHaveLength(1);
    const bad = setup([new Response('', { status: 400 })]);
    await expect(bad.judge.decide!(Q)).rejects.toMatchObject({ code: 'JEV_HTTP' });
    expect(bad.sent).toHaveLength(1);
  });

  it('an answer that is not a probability for the question is an error, not a verdict', async () => {
    for (const body of [{}, { answers: { q: { type: 'choice', choice: 'pass' } } }, { answers: { q: { type: 'noul', noul: 1.4 } } }]) {
      const { judge, costs } = setup([new Response(JSON.stringify(body), { status: 200 })]);
      await expect(judge.decide!(Q)).rejects.toMatchObject({ code: 'JEV_ANSWER' });
      expect(costs).toEqual([]);
    }
  });

  it('a request that never arrives is an error that does not carry the key', async () => {
    const { judge } = setup([new Error('connect ECONNREFUSED')]);
    const err = (await judge.decide!(Q).catch((e: unknown) => e)) as ProviderError;
    expect(err.code).toBe('JEV_UNREACHABLE');
    expect(err.message).not.toContain('key-1');
  });

  it('a failure that is not an Error is still reported, and a usage that is not a count is estimated', async () => {
    const sent: unknown[] = [];
    const judge = makeJevJudge(cfg, {
      env: { TYPESAFE_API_KEY: 'key-1' },
      fetchFn: (async () => {
        sent.push(1);
        throw 'socket hang up';
      }) as unknown as typeof fetch,
      onCost: () => {},
    });
    await expect(judge.decide!(Q)).rejects.toThrow('jev did not answer: socket hang up');

    const odd = setup([answer(0.5, -3)]);
    await odd.judge.decide!(Q);
    expect(odd.costs[0]).toBeCloseTo((Math.ceil(jevState(Q).length / 3) / 1_000_000) * 0.042, 12);
  });

  it('writes the warning to stderr unless told where', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    warnJevExperimental();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toContain('experimental');
    spy.mockRestore();
  });

  it('cannot answer a free-text prompt: the other judged checks do not get it by accident', async () => {
    const { judge, sent } = setup([]);
    await expect(judge.ask('score this')).rejects.toThrow('yes-or-no question only');
    expect(sent).toEqual([]);
  });

  it('says once that it is experimental, where the text goes and what it was measured on', () => {
    const lines: string[] = [];
    warnJevExperimental((l) => lines.push(l));
    warnJevExperimental((l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('experimental');
    expect(lines[0]).toContain('api.typesafe.ai');
    expect(lines[0]).toContain('no reason');
  });
});
