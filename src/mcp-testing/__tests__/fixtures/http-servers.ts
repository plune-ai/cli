// HTTP servers for the connection tests, in the test process on 127.0.0.1 and port 0. Each one records what it was
// asked, headers included, so a test can say what reached it and what did not.

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
}

export interface Fixture {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  requests: Recorded[];
  close(): Promise<void>;
}

async function listen(
  handle: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<Fixture> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers });
    Promise.resolve(handle(req, res)).catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(err));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The server a `whoami` call talks to: its error repeats the credentials it was sent, as a careless server would. */
function echoServer(headers: IncomingHttpHeaders): McpServer {
  const server = new McpServer({ name: 'http-fixture', version: '1.0.0' });
  server.registerTool('whoami', { description: 'Fails, repeating the credentials' }, async () => {
    throw new Error(
      `rejected authorization=${String(headers['authorization'])} x-api-key=${String(headers['x-api-key'])}`,
    );
  });
  return server;
}

/**
 * Streamable HTTP at `/mcp`, stateless. With `token`, a request without `Authorization: Bearer <token>` gets a 401
 * whose body repeats the Authorization it was sent.
 */
export function streamableServer(opts: { token?: string } = {}): Promise<Fixture> {
  return listen(async (req, res) => {
    if (opts.token !== undefined && req.headers['authorization'] !== `Bearer ${opts.token}`) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(`bad credentials: ${String(req.headers['authorization'])}`);
      return;
    }
    if (!req.url?.startsWith('/mcp')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    await echoServer(req.headers).connect(transport);
    await transport.handleRequest(req, res);
  });
}

/** The older HTTP+SSE transport: the stream at `GET /sse`, messages to `POST /messages`. */
export function sseServer(): Promise<Fixture> {
  const transports = new Map<string, SSEServerTransport>();
  return listen(async (req, res) => {
    if (req.method === 'GET' && req.url === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      await echoServer(req.headers).connect(transport);
      return;
    }
    const sessionId = new URL(req.url ?? '', 'http://x').searchParams.get('sessionId') ?? '';
    const transport = transports.get(sessionId);
    if (req.method === 'POST' && transport !== undefined)
      return transport.handlePostMessage(req, res);
    res.writeHead(404);
    res.end();
  });
}

/** Answers everything with a 307 to the same path on `target` (another origin). */
export function redirectServer(target: string): Promise<Fixture> {
  return listen((req, res) => {
    res.writeHead(307, { location: `${target}${req.url ?? '/'}` });
    res.end();
  });
}

/** Records and answers 200 `{}`: the foreign origin a credential must never reach. */
export function recorder(): Promise<Fixture> {
  return listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
}
