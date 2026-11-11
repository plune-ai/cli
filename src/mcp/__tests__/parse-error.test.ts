// `plune mcp serve` answers a stdin line that is not JSON with -32700 and id: null, as JSON-RPC 2.0 asks; the SDK's
// reader alone would drop it without a word. The filter in front of the transport is tested here on its own.

import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { answeringParseErrors, PARSE_ERROR_LINE } from '../server.js';

async function through(chunks: (string | Buffer)[]) {
  const answers: string[] = [];
  let passed = '';
  const out = Readable.from(chunks).pipe(answeringParseErrors((line) => answers.push(line)));
  for await (const chunk of out) passed += String(chunk);
  return { answers, passed };
}

describe('CLI · mcp serve · a line that is not JSON', () => {
  it('is answered with -32700 and id: null, and never reaches the transport', async () => {
    const ping = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const { answers, passed } = await through([`{"jsonrpc": "2.0", "id": 2, "method":\n`, `${ping}\n`]);
    expect(answers).toEqual([PARSE_ERROR_LINE]);
    expect(JSON.parse(PARSE_ERROR_LINE)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    expect(passed).toBe(`${ping}\n`);
  });

  it('passes JSON split across chunks, CRLF lines, blank lines and a last line without a newline as they are', async () => {
    const msg = '{"jsonrpc":"2.0","id":"é","method":"ping"}';
    const bytes = Buffer.from(`${msg}\r\n\n${msg}`);
    // Cut inside the two-byte é, so a decoder that is not streaming would break the line.
    const cut = bytes.indexOf(0xc3) + 1;
    const { answers, passed } = await through([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(answers).toEqual([]);
    expect(passed).toBe(`${msg}\r\n\n${msg}`);
  });
});
