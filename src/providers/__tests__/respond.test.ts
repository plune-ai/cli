import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ProviderError } from '../errors.js';
import type { AgentMessage, StepRequest } from '../../types/provider.js';

const { anthropicCreate, openaiCreate } = vi.hoisted(() => ({
  anthropicCreate: vi.fn(),
  openaiCreate: vi.fn(),
}));
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: anthropicCreate } })),
}));
vi.mock('openai', () => ({
  default: vi.fn(() => ({ chat: { completions: { create: openaiCreate } } })),
}));

import { makeAnthropicProvider } from '../anthropic.js';
import { makeOpenAiProvider, parseToolArguments } from '../openai.js';
import { makeOpenRouterProvider } from '../openrouter.js';
import { makeMockProvider, parseMockScript } from '../mock.js';

const history: AgentMessage[] = [
  { role: 'user', content: 'Read a' },
  {
    role: 'assistant',
    text: 'reading',
    tool_calls: [
      { id: 'c1', name: 'files_read', args: { path: 'a' } },
      { id: 'c2', name: 'echo', args: '{"x":', args_invalid: true },
    ],
  },
  {
    role: 'tool',
    results: [
      { id: 'c1', content: 'contents', is_error: false },
      { id: 'c2', content: 'The arguments are not a JSON object.', is_error: true },
    ],
  },
];
const req = (messages = history): StepRequest => ({
  provider: 'x',
  model: 'm',
  max_tokens: 100,
  messages,
  tools: [
    {
      name: 'files_read',
      description: 'Read',
      input_schema: { properties: { path: { type: 'string' } } },
    },
  ],
});

beforeEach(() => {
  anthropicCreate.mockReset();
  openaiCreate.mockReset();
});

describe('CLI · run · agent loop · anthropic respond', () => {
  const provider = () =>
    makeAnthropicProvider(
      { type: 'anthropic', model: 'm', max_retries: 0 },
      { ANTHROPIC_API_KEY: 'k' },
    );

  it('CLI · run · agent loop · sends tools with input_schema, calls as tool_use, results as tool_result in one user turn', async () => {
    anthropicCreate.mockResolvedValue({
      content: [
        { type: 'text', text: 'one more' },
        { type: 'tool_use', id: 't1', name: 'files_read', input: { path: 'b' } },
      ],
      usage: { input_tokens: 7, output_tokens: 3 },
      stop_reason: 'tool_use',
    });
    const res = await provider().respond!({ ...req(), temperature: 0.2 });
    const sent = anthropicCreate.mock.calls[0]![0];
    expect(sent.temperature).toBe(0.2);
    expect(sent.tools).toEqual([
      {
        name: 'files_read',
        description: 'Read',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ]);
    expect(sent.messages).toEqual([
      { role: 'user', content: 'Read a' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading' },
          { type: 'tool_use', id: 'c1', name: 'files_read', input: { path: 'a' } },
          { type: 'tool_use', id: 'c2', name: 'echo', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'contents', is_error: false },
          {
            type: 'tool_result',
            tool_use_id: 'c2',
            content: 'The arguments are not a JSON object.',
            is_error: true,
          },
        ],
      },
    ]);
    expect(res).toEqual({
      text: 'one more',
      tool_calls: [{ id: 't1', name: 'files_read', args: { path: 'b' } }],
      usage: { input_tokens: 7, output_tokens: 3 },
      finish_reason: 'tool_calls',
    });
  });

  it('CLI · run · agent loop · normalises the stop reason and leaves an empty assistant text out', async () => {
    for (const [stop, want] of [
      ['end_turn', 'stop'],
      ['max_tokens', 'length'],
      ['pause_turn', 'pause_turn'],
      [null, undefined],
    ] as const) {
      anthropicCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'x' }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: stop,
      });
      expect(
        (await provider().respond!(req([{ role: 'assistant', text: '', tool_calls: [] }])))
          .finish_reason,
      ).toBe(want);
    }
    expect(anthropicCreate.mock.calls[0]![0].messages).toEqual([
      { role: 'assistant', content: [] },
    ]);
    expect(anthropicCreate.mock.calls[0]![0]).not.toHaveProperty('temperature');
  });

  it('CLI · run · agent loop · a failed call is a ProviderError with the key masked', async () => {
    anthropicCreate.mockRejectedValue(Object.assign(new Error('bad key k'), { status: 401 }));
    await expect(provider().respond!(req())).rejects.toBeInstanceOf(Error);
  });
});

describe('CLI · run · agent loop · openai and openrouter respond', () => {
  const answer = (message: object, extra: object = {}) => ({
    choices: [{ message, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
    ...extra,
  });

  it('CLI · run · agent loop · sends function tools, calls with JSON-string arguments, one tool message per result', async () => {
    openaiCreate.mockResolvedValue(
      answer({
        content: null,
        tool_calls: [
          {
            id: 'o1',
            type: 'function',
            function: { name: 'files_read', arguments: '{"path":"b"}' },
          },
          { id: 'o2', type: 'function', function: { name: 'echo', arguments: '{"text":' } },
          { id: 'o3', type: 'custom', custom: { name: 'x', input: '' } },
        ],
      }),
    );
    const res = await makeOpenAiProvider(
      { type: 'openai', model: 'm', max_retries: 0 },
      { OPENAI_API_KEY: 'k' },
    ).respond!(req());
    const sent = openaiCreate.mock.calls[0]![0];
    expect(sent).not.toHaveProperty('usage');
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'files_read',
          description: 'Read',
          parameters: { properties: { path: { type: 'string' } } },
        },
      },
    ]);
    expect(sent.messages).toEqual([
      { role: 'user', content: 'Read a' },
      {
        role: 'assistant',
        content: 'reading',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'files_read', arguments: '{"path":"a"}' },
          },
          { id: 'c2', type: 'function', function: { name: 'echo', arguments: '{"x":' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'contents' },
      { role: 'tool', tool_call_id: 'c2', content: 'The arguments are not a JSON object.' },
    ]);
    expect(res).toEqual({
      text: '',
      tool_calls: [
        { id: 'o1', name: 'files_read', args: { path: 'b' } },
        { id: 'o2', name: 'echo', args: '{"text":', args_invalid: true },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
      finish_reason: 'tool_calls',
    });
  });

  it('CLI · run · agent loop · an assistant turn without calls has no tool_calls and a null content when empty', async () => {
    openaiCreate.mockResolvedValue({ choices: [] });
    const res = await makeOpenAiProvider(
      { type: 'openai', model: 'm', temperature: 0 },
      { OPENAI_API_KEY: 'k' },
    ).respond!({
      ...req([{ role: 'assistant', text: '', tool_calls: [] }]),
      temperature: 0,
    });
    expect(openaiCreate.mock.calls[0]![0].messages).toEqual([{ role: 'assistant', content: null }]);
    expect(openaiCreate.mock.calls[0]![0].temperature).toBe(0);
    expect(res).toEqual({ text: '', tool_calls: [], usage: { input_tokens: 0, output_tokens: 0 } });
  });

  it('CLI · run · agent loop · openrouter asks for and reports the real cost, and an error inside a 200 is finish_reason error', async () => {
    openaiCreate.mockResolvedValue(
      answer(
        { content: 'done' },
        { usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.003 } },
      ),
    );
    const or = makeOpenRouterProvider(
      { type: 'openrouter', model: 'm', max_retries: 0 },
      { OPENROUTER_API_KEY: 'k' },
    );
    const res = await or.respond!(req());
    expect(openaiCreate.mock.calls[0]![0].usage).toEqual({ include: true });
    expect(res.cost_usd).toBe(0.003);

    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: '' }, error: { code: 502 } }],
      usage: {},
    });
    expect((await or.respond!(req())).finish_reason).toBe('error');
  });

  it('CLI · run · agent loop · a failed call is normalised like complete()', async () => {
    openaiCreate.mockRejectedValue(Object.assign(new Error('server down'), { status: 500 }));
    const p = makeOpenAiProvider(
      { type: 'openai', model: 'm', max_retries: 0 },
      { OPENAI_API_KEY: 'k' },
    );
    await expect(p.respond!(req())).rejects.toBeInstanceOf(ProviderError);
  });

  it('CLI · run · agent loop · parseToolArguments keeps what does not parse to an object as sent', () => {
    expect(parseToolArguments('a', 'n', '')).toEqual({ id: 'a', name: 'n', args: {} });
    expect(parseToolArguments('a', 'n', '[1]')).toEqual({
      id: 'a',
      name: 'n',
      args: '[1]',
      args_invalid: true,
    });
    expect(parseToolArguments('a', 'n', 'null')).toEqual({
      id: 'a',
      name: 'n',
      args: 'null',
      args_invalid: true,
    });
  });
});

describe('CLI · run · agent loop · mock script', () => {
  it('CLI · run · agent loop · a scripted mock plays its steps, then repeats the last', async () => {
    const mock = makeMockProvider(
      parseMockScript('[{"tool_calls":[{"name":"echo","args":{"text":"hi"}}]},{"text":"done"}]'),
    );
    const first = await mock.respond!(req([{ role: 'user', content: 'x' }]));
    expect(first).toMatchObject({
      tool_calls: [{ id: 'call_0_0', name: 'echo', args: { text: 'hi' } }],
      finish_reason: 'tool_calls',
    });
    const later = await mock.respond!(req());
    expect(later).toMatchObject({ text: 'done', tool_calls: [], finish_reason: 'stop' });
    const tool = makeMockProvider([{ tool_calls: [{ name: 'echo' }] }]);
    expect((await tool.respond!(req())).tool_calls[0]!.args).toEqual({});
  });

  it('CLI · run · agent loop · without a script the mock takes no tools', () => {
    expect(makeMockProvider().respond).toBeUndefined();
  });

  it('CLI · run · agent loop · a script that is not a list of steps is refused with a reason', () => {
    expect(() => parseMockScript('{')).toThrow('is not JSON');
    for (const bad of [
      '[]',
      '{}',
      '[1]',
      '[{"text":1}]',
      '[{"tool_calls":{}}]',
      '[{"tool_calls":[{}]}]',
    ])
      expect(() => parseMockScript(bad)).toThrow(/non-empty list of steps/);
  });
});
