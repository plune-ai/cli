import {
  test as base,
  expect,
  type Fixtures,
  type PlaywrightTestArgs,
  type PlaywrightTestOptions,
  type PlaywrightWorkerArgs,
  type PlaywrightWorkerOptions,
} from '@playwright/test';
import { FINDINGS_TYPE, secretValues, watch } from './findings.js';

/**
 * `@plune-ai/playwright/fixture` — collects what the browser reported during a test (console errors, page
 * errors, failed and slow requests) and attaches it for the reporter.
 *
 * The one file of this package that imports `@playwright/test` at runtime, which is why it is an entry of
 * its own: the reporter entry imports only its types.
 */

export interface PluneFindingsOptions {
  /** Collect what the browser reports. On by default; `test.use({ pluneFindings: false })` turns it off. */
  pluneFindings: boolean;
  /** A request that took this long, in milliseconds, is reported as slow. Default 3000. */
  pluneSlowRequestMs: number;
  /**
   * NAMES of environment variables whose values must never leave the test process: each value is replaced by
   * `‹env-secret›` in every text and path. Names and not values on purpose: an option can be read by any
   * reporter and written into a report; a name is safe there. Default none.
   */
  pluneSecretEnv: string[];
}

const SLOW_MS = 3000;

/**
 * The fixture definitions, for a project that already has its own `test`: `base.extend(findingsFixtures)`,
 * or `mergeTests` with the `test` below.
 *
 * `context` is overridden, not `page` wrapped in an automatic fixture: a test that asks for no browser gets
 * none opened for it, and then attaches nothing — which reads as «not collected».
 * A context a test opens itself with `browser.newContext()` is not this fixture and is not listened to.
 */
export const findingsFixtures: Fixtures<
  PluneFindingsOptions,
  object,
  PlaywrightTestArgs & PlaywrightTestOptions,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions
> = {
  pluneFindings: [true, { option: true }],
  pluneSlowRequestMs: [SLOW_MS, { option: true }],
  pluneSecretEnv: [[], { option: true }],
  context: async (
    { context, pluneFindings, pluneSlowRequestMs, pluneSecretEnv },
    use,
    testInfo,
  ) => {
    const collector = pluneFindings
      ? watch(
          context,
          Number.isFinite(pluneSlowRequestMs) && pluneSlowRequestMs >= 0
            ? pluneSlowRequestMs
            : SLOW_MS,
          // Read when the test's browser opens: the values this worker has now.
          secretValues(pluneSecretEnv),
        )
      : undefined;
    await use(context);
    if (collector === undefined) return;
    try {
      // Also when nothing was found: an empty list says «collected, nothing found», no attachment says «not collected».
      await testInfo.attach('plune-findings', {
        body: JSON.stringify(collector.result()),
        contentType: FINDINGS_TYPE,
      });
    } catch {
      // The findings are lost; the test's own outcome is not this fixture's to change.
    }
  },
};

export const test = base.extend<PluneFindingsOptions>(findingsFixtures);
export { expect };
