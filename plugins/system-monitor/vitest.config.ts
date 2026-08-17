import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-system-monitor",
    silent: "passed-only",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
