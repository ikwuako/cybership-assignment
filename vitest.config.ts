import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
    },
    // Ensure nock can intercept axios requests
    // nock works with Node's http module which axios uses under the hood
    setupFiles: ['./tests/setup.ts'],
  },
  resolve: {
    // Allow imports with .js extension (NodeNext compat)
    conditions: ['node', 'import'],
  },
});
