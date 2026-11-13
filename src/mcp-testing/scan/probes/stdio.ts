import { ConnectError, type Session } from '../../connect/session.js';
import type { Frame, Reply } from './guard.js';

/**
 * The transport of the probes for a stdio server: the twin of `http.ts`. It speaks through the raw layer of a
 * session the runner opened (one line on the child stdin, the answer with the same id from its stdout) and returns
 * the same `Reply` the HTTP one does, so the wrapper in front of it is one wrapper for both. A child that exits, closes
 * its pipe or says nothing is a transport failure (`failure`), never an answer. There is no credential on stdio, and no
 * metadata request: neither is sent.
 *
 * Built by the runner and handed to the guard once; it is not exported to anything else.
 */
export function stdioTransport(
  session: Session,
  timeoutMs: number,
): (frame: Frame) => Promise<Reply> {
  let nextId = 1;
  return async (frame) => {
    if (frame.type !== 'rpc') return { kind: 'failure', why: 'network' };
    try {
      const id = frame.notification === true ? undefined : nextId++;
      const body = JSON.stringify({
        jsonrpc: '2.0',
        ...(id === undefined ? {} : { id }),
        method: frame.method,
        ...(frame.params === undefined ? {} : { params: frame.params }),
      });
      if (id === undefined) {
        await session.notify(body);
        return { kind: 'http', status: 202 };
      }
      const answer = await session.raw(body, id, { timeoutMs });
      const bytes = answer.text.length;
      return answer.frame === undefined
        ? { kind: 'http', status: 200, bytes }
        : { kind: 'http', status: 200, message: answer.frame, bytes };
    } catch (err) {
      return {
        kind: 'failure',
        why: err instanceof ConnectError && err.kind === 'timeout' ? 'timeout' : 'network',
      };
    }
  };
}
