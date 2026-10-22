import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Docker-based integration tests run with `npm run test:container` (vitest.container.config.ts).
    exclude: [...configDefaults.exclude, 'tests/container/**'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
