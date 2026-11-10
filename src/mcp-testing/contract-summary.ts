// The run summary of a pull request: this branch's tool contract, taken live, against the base branch's snapshot file.
// Prints Markdown to stdout. A path that does not exist means the base branch has no snapshot yet.
// Usage: tsx src/mcp-testing/contract-summary.ts <base snapshot file>

import { existsSync, readFileSync } from 'node:fs';
import { pluneContractSummary, pluneToolsSnapshot } from './plune-snapshot.js';

const basePath = process.argv[2];
const base = basePath !== undefined && existsSync(basePath) ? readFileSync(basePath, 'utf8') : null;
process.stdout.write(pluneContractSummary(base, await pluneToolsSnapshot()));
