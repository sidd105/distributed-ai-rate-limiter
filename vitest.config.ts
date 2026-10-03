import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
    coverage: { reporter: ['text', 'html'] },
  },
});
