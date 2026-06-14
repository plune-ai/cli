import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/', 'coverage/', 'node_modules/', '*.config.ts', '*.config.js'],
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Module-boundary purity (spec §6 NFR "Footprint" / §10 QG-3): the shared kernel
    // src/types + src/util must stay I/O-free ("pure core, dirty edges"). node:crypto is
    // pure compute and allowed; filesystem / network / process modules are forbidden.
    // Tests are excluded — they legitimately read files (e.g. the golden snapshot).
    files: ['src/types/**/*.ts', 'src/util/**/*.ts'],
    ignores: ['**/__tests__/**', '**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                'fs', 'node:fs', 'fs/*', 'node:fs/*',
                'net', 'node:net',
                'http', 'node:http', 'https', 'node:https', 'http2', 'node:http2',
                'child_process', 'node:child_process',
                'process', 'node:process',
                'os', 'node:os',
                'dns', 'node:dns', 'dns/*', 'node:dns/*',
                'tls', 'node:tls',
                'dgram', 'node:dgram',
                'cluster', 'node:cluster',
                'worker_threads', 'node:worker_threads',
                'readline', 'node:readline', 'readline/*', 'node:readline/*',
                'inspector', 'node:inspector',
                'perf_hooks', 'node:perf_hooks',
                'v8', 'node:v8',
                'vm', 'node:vm',
              ],
              message:
                'src/types and src/util must stay I/O-free (pure core, dirty edges — spec §6 NFR / §10 QG-3). node:crypto (pure compute) is allowed; filesystem/network/process modules are not.',
            },
          ],
        },
      ],
    },
  },
];
