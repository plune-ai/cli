import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthError } from '../../../providers/errors.js';

const { mockHandleRun } = vi.hoisted(() => ({ mockHandleRun: vi.fn() }));

// Mock the run handler so we can drive the CLI's error mapping with a provider AuthError,
// before the orchestrator (S3) wires providers into the real run pipeline.
vi.mock('../run.js', () => ({ handleRun: mockHandleRun }));

import { createProgram } from '../../../cli.js';

beforeEach(() => {
  mockHandleRun.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('run command — AuthError → exit 2 (AC-8)', () => {
  it('maps a provider AuthError to exit 2 with the env var hint', async () => {
    mockHandleRun.mockRejectedValue(
      new AuthError('Missing OPENAI_API_KEY. Set it in your environment.', 'OPENAI_API_KEY'),
    );

    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
      return true;
    });
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as (code?: string | number | null | undefined) => never);

    await createProgram().parseAsync(['node', 'plune', 'run']);

    expect(exitSpy).toHaveBeenCalledWith(2);
    expect(stderr.join('')).toContain('OPENAI_API_KEY');
  });
});
