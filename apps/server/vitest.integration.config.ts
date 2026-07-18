import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/integration/**/*.test.ts", "test/**/*.integration.test.ts"],
    // These files share one Postgres database; run them serially to avoid
    // cross-file interference on the shared schema.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
