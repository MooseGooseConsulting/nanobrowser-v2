import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // `tests/` holds cross-cutting suites; UI suites live beside the code they cover.
    // DOM-dependent files opt in per file with `// @vitest-environment jsdom`.
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}', 'entrypoints/**/*.test.{ts,tsx}'],
    environment: 'node',
    restoreMocks: true,
  },
});
