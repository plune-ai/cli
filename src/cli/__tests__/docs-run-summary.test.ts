// The README and the guides show the `plune run` summary line as the CLI prints it
// (`N passed · N failed · N errored · N total · $0.0000 · Nms`, see src/reporters/console.ts),
// never as `N/N passed ·`.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILES = [
  'README.md',
  'docs/guide/cli.md',
  'docs/guide/getting-started.md',
  'docs/guide/introduction.md',
];

describe('docs show the run summary line the CLI prints', () => {
  it.each(FILES)('%s has no `N/N passed ·`', (file) => {
    const text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect(text).not.toMatch(/\d+\/\d+ passed ·/);
  });
});
