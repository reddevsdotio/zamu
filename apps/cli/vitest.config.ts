import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@zamu/cli',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.ts'],
    passWithNoTests: true,
    // Tests run the real API on a throwaway Postgres database (created and seeded in beforeAll).
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
