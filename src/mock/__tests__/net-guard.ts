// A guard for tests of code that may open connections: every socket this process connects goes through
// it, `fetch` and `http(s).request` included, and one to an address that is not loopback is refused and
// written down. A test that would reach the real network fails instead.

import * as net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export interface NetGuard {
  /** `host:port` of every connection tried, in order. */
  readonly seen: string[];
  /** The ones that were refused: not loopback. */
  readonly refused: string[];
  restore(): void;
}

export function guardNetwork(): NetGuard {
  const original = net.Socket.prototype.connect;
  const seen: string[] = [];
  const refused: string[] = [];
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
    // `net.connect` hands over its arguments already gathered into one array.
    const list = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
    const first = list[0];
    let host = 'localhost';
    let port: unknown = first;
    if (typeof first === 'object' && first !== null) {
      const options = first as { host?: string; port?: unknown; path?: string | null };
      // A pipe or a Unix socket: local by nature.
      if (typeof options.path === 'string')
        return original.apply(this, args as never) as net.Socket;
      host = options.host ?? host;
      port = options.port;
    } else if (typeof list[1] === 'string') host = list[1];
    seen.push(`${host}:${String(port)}`);
    if (!LOOPBACK.has(host)) {
      refused.push(`${host}:${String(port)}`);
      throw new Error('A test tried to connect to an address that is not loopback');
    }
    return original.apply(this, args as never) as net.Socket;
  } as typeof net.Socket.prototype.connect;
  return {
    seen,
    refused,
    restore() {
      net.Socket.prototype.connect = original;
    },
  };
}
