// `plune mock` through its handler, with everything it prints captured. The upstream is a fake server on
// 127.0.0.1, and a guard on the sockets of this process fails any connection that is not loopback.

import { once } from 'node:events';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../../cli.js';
import { guardNetwork, type NetGuard } from '../../../mock/__tests__/net-guard.js';
import type { Outbound } from '../../../mock/record.js';
import { handleMock, MockUsageError, type MockFlags } from '../mock.js';

const KEY = 'sk-test-9f8e7d6c5b4a3210';
// What is left of the key in any encoding of it.
const KEY_CORE = '9f8e7d6c5b4a';

let guard: NetGuard;
let dir: string;
let upstream: http.Server;
let origin: string;
let upstreamCalls = 0;

beforeAll(async () => {
  guard = guardNetwork();
  // Echoes the credentials it was sent, in the body and in headers, as a careless API might.
  upstream = http.createServer((req, res) => {
    upstreamCalls += 1;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-echo-key': String(req.headers['x-api-key']),
        'set-cookie': `session=${KEY}`,
      });
      res.end(
        JSON.stringify({
          id: 'chat-1',
          choices: [{ message: { role: 'assistant', content: 'Hello, John Doe' } }],
          debug: { authorization: req.headers.authorization, url: req.url },
        }),
      );
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(async () => {
  guard.restore();
  upstream.closeAllConnections();
  await new Promise((resolve) => upstream.close(resolve));
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plune-mock-'));
  guard.seen.length = 0;
  upstreamCalls = 0;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  expect(guard.refused.splice(0)).toEqual([]);
});

const flags = (more: Partial<MockFlags> = {}): MockFlags => ({
  file: 'chat.stubs.yaml',
  record: false,
  force: false,
  scope: 'default',
  port: 0,
  ...more,
});

interface Running {
  url: string;
  out: string[];
  err: string[];
  stop(): Promise<void>;
}

/** Starts the command and waits until it listens; `stop` is what Ctrl+C does. */
async function run(f: MockFlags, outbound?: Outbound): Promise<Running> {
  const out: string[] = [];
  const err: string[] = [];
  const stopper = new AbortController();
  let ready!: (url: string) => void;
  const listening = new Promise<string>((resolve) => (ready = resolve));
  const done = handleMock(f, {
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    signal: stopper.signal,
    cwd: dir,
    onReady: ready,
    today: () => '2026-01-02',
    ...(outbound === undefined ? {} : { outbound }),
  });
  const url = await Promise.race([listening, done.then(() => '')]);
  return {
    url,
    out,
    err,
    stop: async () => {
      stopper.abort();
      await done;
    },
  };
}

const ask = (url: string) =>
  fetch(`${url}/v1/chat/completions?api_key=${KEY}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
      'x-api-key': KEY,
    },
    body: JSON.stringify({
      model: 'm',
      messages: [{ role: 'user', content: 'Say hello to John Doe' }],
    }),
  });

/** Every file under the folder, as bytes read as latin1 so that nothing is lost in decoding. */
function everythingWritten(folder: string): string {
  return fs
    .readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => fs.readFileSync(path.join(e.parentPath, e.name), 'latin1'))
    .join('\n');
}

describe('CLI · mock · record then replay', () => {
  it('writes the key nowhere: not into the stub file, another file, stdout or stderr', async () => {
    const recording = await run(flags({ record: true, target: origin }));
    const live = await ask(recording.url);
    const liveBody = await live.text();
    // The client gets the answer as the upstream gave it, key and all.
    expect(liveBody).toContain(KEY);
    await recording.stop();

    expect(fs.readdirSync(dir)).toEqual(['chat.stubs.yaml']);
    const written = everythingWritten(dir);
    const printed = [...recording.out, ...recording.err].join('');
    expect(written).toContain('Hello, John Doe');
    expect(written).not.toContain(KEY_CORE);
    expect(printed).not.toContain(KEY_CORE);
    expect(printed).toContain('recorded: POST 200\n');
    expect(printed).toContain('Stopped. Exchanges recorded: 1.\n');
    expect(printed).toMatch(/may hold personal or confidential text/);
  });

  it('replays the recorded file with no outbound request', async () => {
    const recording = await run(flags({ record: true, target: origin }));
    await (await ask(recording.url)).text();
    await recording.stop();
    expect(upstreamCalls).toBe(1);

    guard.seen.length = 0;
    const outbound = vi.fn<Parameters<Outbound>, ReturnType<Outbound>>(() => {
      throw new Error('serving a stub file made an outbound request');
    });
    const serving = await run(flags(), outbound);
    const first = await ask(serving.url);
    const second = await ask(serving.url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/json');
    expect(first.headers.get('set-cookie')).toBeNull();
    expect(first.headers.get('x-echo-key')).toBeNull();
    const body = (await first.json()) as { choices: unknown; debug: unknown };
    expect(body.choices).toEqual([{ message: { role: 'assistant', content: 'Hello, John Doe' } }]);
    expect(body.debug).toEqual({
      authorization: '[masked]',
      url: '/v1/chat/completions?api_key=[masked]',
    });
    expect(await second.json()).toEqual(body);
    await serving.stop();

    expect(outbound).not.toHaveBeenCalled();
    expect(upstreamCalls).toBe(1);
    // The only connections of the process were the client's own, to the stub server.
    expect(new Set(guard.seen)).toEqual(new Set([`127.0.0.1:${new URL(serving.url).port}`]));
    expect(serving.out.join('')).toBe(
      `Serving 1 stubs at ${serving.url}, with no network. Ctrl+C stops.\nStopped. Stubs never called: 0.\n`,
    );
  });

  it('stops on the signal with the file whole, and frees the port', async () => {
    const recording = await run(flags({ record: true, target: origin }));
    const port = Number(new URL(recording.url).port);
    await (await ask(recording.url)).text();
    await recording.stop();
    const again = await run(flags({ record: true, target: origin, port, force: true }));
    expect(new URL(again.url).port).toBe(String(port));
    await again.stop();
  });
});

describe('CLI · mock · what it refuses', () => {
  it.each([
    ['--record without --target', flags({ record: true }), /--record and --target go together/],
    [
      '--target without --record',
      flags({ target: 'http://127.0.0.1:1' }),
      /--record and --target go together/,
    ],
    ['--force without --record', flags({ force: true }), /--force goes with --record/],
    [
      'a target that is no http(s) origin',
      flags({ record: true, target: 'ftp://127.0.0.1' }),
      /http: or https:/,
    ],
    [
      'a path outside the folder',
      flags({ record: true, target: 'http://127.0.0.1:1', file: '../x.yaml' }),
      /inside the current project folder only/,
    ],
    [
      'a bad scope',
      flags({ record: true, target: 'http://127.0.0.1:1', scope: 'a/b' }),
      /Bad --scope/,
    ],
    ['a stub file that is not there', flags(), /Cannot read stub file/],
  ])('%s is a usage error, and nothing is written or connected', async (_name, f, message) => {
    const out: string[] = [];
    await expect(
      handleMock(f, {
        stdout: (t) => out.push(t),
        stderr: (t) => out.push(t),
        signal: new AbortController().signal,
        cwd: dir,
      }),
    ).rejects.toThrow(message);
    await expect(
      handleMock(f, {
        stdout: () => undefined,
        stderr: () => undefined,
        signal: new AbortController().signal,
        cwd: dir,
      }),
    ).rejects.toBeInstanceOf(MockUsageError);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(out).toEqual([]);
    expect(guard.seen).toEqual([]);
  });

  it('does not replace a recording without --force', async () => {
    fs.writeFileSync(path.join(dir, 'chat.stubs.yaml'), 'version: 1\nstubs: []\n');
    await expect(run(flags({ record: true, target: origin }))).rejects.toThrow(/exists already/);
    expect(fs.readFileSync(path.join(dir, 'chat.stubs.yaml'), 'utf8')).toBe(
      'version: 1\nstubs: []\n',
    );
  });

  it('refuses a stub file with a bad field, naming the field', async () => {
    fs.writeFileSync(
      path.join(dir, 'chat.stubs.yaml'),
      'version: 1\nstubs:\n  - path: no-slash\n    response: {}\n',
    );
    await expect(run(flags())).rejects.toThrow(/stubs\.0\.path/);
  });
});

describe('CLI · mock · help', () => {
  it('is registered, and its help says what a recording holds', () => {
    const command = createProgram().commands.find((c) => c.name() === 'mock')!;
    let help = '';
    command.configureOutput({ writeOut: (text) => (help += text) });
    command.outputHelp();
    expect(help).toContain('--record');
    expect(help).toContain('--target <origin>');
    expect(help).toMatch(
      /prompts and the answers as they were sent and received: they may hold personal or confidential text/,
    );
    expect(help).toMatch(/never uploaded/);
    expect(help).toMatch(/Redirects are passed back, not followed/);
    expect(help).toMatch(/Timing is not recorded/);
  });
});
