import { describe, it, expect } from 'vitest';
import { createProgram } from '../../../cli.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(fileURLToPath(new URL('../../../../package.json', import.meta.url)));
const pkgVersion: string = JSON.parse(readFileSync(pkgPath, 'utf-8')).version as string;

describe('plune --version', () => {
  it('program version matches package.json', () => {
    const program = createProgram();
    expect(program.version()).toBe(pkgVersion);
  });
});
