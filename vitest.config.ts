import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Node.js wiring of the CLI; exercised end-to-end by test/cli.test.ts and scripts/smoke.mjs
      exclude: ["src/cli.ts"],
      reporter: ["text", "json-summary"],
      thresholds: { statements: 95, branches: 90, functions: 95, lines: 95 },
    },
  },
});
