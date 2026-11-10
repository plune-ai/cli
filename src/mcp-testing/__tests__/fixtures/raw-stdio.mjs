// Stdio servers that misbehave, written as plain JSON-RPC so nothing in an SDK corrects them. The mode is argv[2]:
// - `crash`: 25 lines of stderr naming a home folder, then exit 3 before reading anything;
// - `silent`: reads stdin and never answers (starts a grandchild when asked, see child-helpers.mjs);
// - `loose-schema`: answers `initialize`, then a `tools/list` whose inputSchema has no `type` and carries a field
//   no schema knows;
// - `noisy`: `loose-schema` that first logs a plain line, API_TOKEN in it, on stdout.
// - `bare`: answers `initialize`, then one `tools/list` page of BARE_TOOLS tools without a description or
//   annotations.

import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startGrandchild, writePids } from './child-helpers.mjs';

export const BARE_TOOLS = 140_000;

const mode = process.argv[2];

if (mode === 'crash') {
  for (let i = 1; i <= 25; i++)
    process.stderr.write(`line ${i}: cannot read ${join(homedir(), 'server', 'config.json')}\n`);
  process.exit(3);
}

if (mode === 'silent') {
  writePids(startGrandchild());
  process.stdin.resume();
}

if (mode === 'noisy') {
  process.stdout.write(`booting with API_TOKEN=${process.env.API_TOKEN}\n`);
}

if (mode === 'loose-schema' || mode === 'noisy' || mode === 'bare') {
  const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.id === undefined) return;
    if (msg.method === 'initialize') {
      send({
        id: msg.id,
        result: {
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'loose', version: '0.0.1' },
        },
      });
    } else if (msg.method === 'tools/list') {
      send({
        id: msg.id,
        result: {
          tools:
            mode === 'bare'
              ? Array.from({ length: BARE_TOOLS }, (_, i) => ({
                  name: `t${i}`,
                  inputSchema: { type: 'object' },
                }))
              : [{ name: 'odd', inputSchema: { properties: { q: {} } }, 'x-extra': 1 }],
        },
      });
    } else {
      send({ id: msg.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
}
