import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const sources = fs
  .readdirSync(path.join(root, 'src'), { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith('.ts'))
  .map((e) => fs.readFileSync(path.join(root, 'src', e.name), 'utf8'));

/**
 * ADR 0023 splits the reporter in two: a core that knows the platform and adapters that know a
 * runner. That split is a sentence in a document until something checks it — and the way it
 * erodes is not a rewrite, it is one `fetch` added here because it was three lines shorter than
 * threading it through the core.
 */
describe('the adapter knows Playwright, not the platform', () => {
  it.each([
    ['a request', /\bfetch\s*\(/],
    ['an auth header', /Bearer/],
    ['a platform route', /\/v1\//],
    ['a key ranking', /allure-history|cairn-stable|testrail/],
  ])('contains no %s', (_what, pattern) => {
    expect(sources.filter((src) => pattern.test(src))).toEqual([]);
  });
});

/**
 * AC-13, asserted on the artifact rather than on the intention.
 *
 * The failure this guards is specific and has happened here before, one level down: a package
 * that pulls a native SQLite build and two provider SDKs behind it because something in the
 * dependency graph needed one function. `4ea7d92` fixed that for the CLI's consumers; this keeps
 * it fixed for the adapter's.
 */
describe('what installing this package costs', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it('declares no runtime dependencies', () => {
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('asks only for the runner it reports on', () => {
    expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(['@playwright/test']);
  });

  it('imports nothing at runtime but Node itself', () => {
    const bundle = fs.readFileSync(path.join(root, 'dist', 'index.js'), 'utf8');
    const specifiers = [...bundle.matchAll(/(?:from|require\()\s*["']([^"']+)["']/g)].map(
      (m) => m[1] as string,
    );

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith('node:') && !isNodeBuiltin(s))).toEqual([]);
  });

  /**
   * The size ceiling is the one that can actually go red, and it took a deliberate attempt to
   * break the others to find that out.
   *
   * tsup bundles anything not declared in `dependencies`/`peerDependencies`, and it cannot
   * externalize a subpath import at all — so the check above cannot fail while the manifest stays
   * clean, whatever anyone imports. What *does* change when a library sneaks in is the weight:
   * this bundle is the core plus a few hundred lines of Playwright mapping, and any real
   * dependency doubles it several times over.
   *
   * The number is generous on purpose. It is not a budget for the adapter to grow into — it is a
   * tripwire for "something else came along".
   */
  it('weighs what a fetch client and a mapping layer weigh', () => {
    const bytes = fs.statSync(path.join(root, 'dist', 'index.js')).size;

    expect(bytes).toBeLessThan(64 * 1024);
  });
});

/** The builtins this bundle actually reaches for. Named rather than derived from `module.builtinModules`
 * so that adding a new one is a visible change, not a silent one. */
function isNodeBuiltin(specifier: string): boolean {
  return ['crypto', 'fs', 'os', 'path', 'url', 'util'].includes(specifier);
}
