// The tool contract of `plune mcp serve` against its snapshot in the repository. A difference fails with the changes
// classified; the file changes only on purpose: UPDATE_MCP_SNAPSHOT=1 writes it, nothing else does.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUNE_TOOLS } from '../../mcp-tools/index.js';
import { PLUNE_SNAPSHOT_FILE, pluneContractSummary, pluneToolsSnapshot } from '../plune-snapshot.js';
import { diffSnapshots, parseSnapshot, renderDiffText, serializeSnapshot, SNAPSHOT_FORMAT, type ToolSnapshot } from '../snapshot/index.js';

const FILE = join(__dirname, '..', '..', '..', PLUNE_SNAPSHOT_FILE);
const UPDATE_HINT = `If the change is meant, write the file with UPDATE_MCP_SNAPSHOT=1 and commit it (vitest run src/mcp-testing/__tests__/plune-tools-snapshot.test.ts).`;

/** Every tool of the contract is in the snapshot, with the contract's own visibility and write: nothing listed is nothing checked. */
function expectWholeContract(snapshot: ToolSnapshot): void {
  const want = [...PLUNE_TOOLS].map((t) => ({ name: t.name, plune: { visibility: t.visibility, write: t.write } })).sort((a, b) => (a.name < b.name ? -1 : 1));
  expect(snapshot.tools.map((t) => ({ name: t.name, plune: t['x-plune'] }))).toEqual(want);
  expect(snapshot.tools.length).toBe(PLUNE_TOOLS.length);
}

describe('CLI · mcp snapshot · Plune tools contract', () => {
  it(`the live tools/list matches ${PLUNE_SNAPSHOT_FILE}`, async () => {
    const live = await pluneToolsSnapshot();
    expectWholeContract(live);
    const text = serializeSnapshot(live);

    if (process.env['UPDATE_MCP_SNAPSHOT'] === '1') {
      const was = existsSync(FILE) ? readFileSync(FILE, 'utf8') : null;
      writeFileSync(FILE, text);
      console.info(`Wrote ${PLUNE_SNAPSHOT_FILE}.\n${was === null ? 'A new file.' : renderDiffText(diffSnapshots(parseSnapshot(was), live))}`);
      return;
    }
    if (!existsSync(FILE)) expect.fail(`${PLUNE_SNAPSHOT_FILE} does not exist. ${UPDATE_HINT}`);
    const saved = readFileSync(FILE, 'utf8');
    if (saved === text) return;
    const diff = diffSnapshots(parseSnapshot(saved), live);
    expect.fail(
      [
        `The tool contract differs from ${PLUNE_SNAPSHOT_FILE}.`,
        diff.changes.length === 0 ? 'The contract is the same; only the text of the file differs (formatting, line endings, an edit by hand, or a file written by an older normalization).' : renderDiffText(diff),
        'The contract is shared by `plune mcp serve` and the platform\'s built-in agent: a change reaches both.',
        UPDATE_HINT,
      ].join('\n'),
    );
  });

  it('two independent builds of the snapshot give the same text byte for byte', async () => {
    const [a, b] = await Promise.all([pluneToolsSnapshot(), pluneToolsSnapshot()]);
    expect(serializeSnapshot(a)).toBe(serializeSnapshot(b));
  });

  it('a snapshot of zero tools is not a pass', () => {
    expect(() => expectWholeContract({ format: SNAPSHOT_FORMAT, tools: [] })).toThrow();
  });

  it('the pull request summary: no base, no change, a change', async () => {
    const live = await pluneToolsSnapshot();
    expect(pluneContractSummary(null, live)).toContain('No snapshot of the tool contract on the base branch yet');
    expect(pluneContractSummary(serializeSnapshot(live), live)).toContain('No changes to the tool contract.');

    const base = parseSnapshot(serializeSnapshot(live));
    base.tools = base.tools.filter((t) => t.name !== 'plune_get');
    const summary = pluneContractSummary(serializeSnapshot(base), live);
    expect(summary).toContain('**Overall: non-breaking**');
    expect(summary).toContain('| non-breaking | `plune_get` | `tool` | added | A new tool. |');
  });
});
