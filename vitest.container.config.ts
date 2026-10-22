import { defineConfig } from 'vitest/config';

// Integration tests for the Rubber Band container and the /api Worker. They need Docker.
export default defineConfig({
  test: {
    include: ['tests/container/**/*.test.ts'],
    environment: 'node',
    testTimeout: 300_000,
    hookTimeout: 900_000,
    fileParallelism: false,
  },
});
