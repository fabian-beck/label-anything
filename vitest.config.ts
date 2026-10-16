import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["ts/packages/*/test/**/*.test.ts", "bindings/js-extras/test/**/*.test.ts"],
    testTimeout: 30000,
  },
});
