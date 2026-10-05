import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-agent-calendar",
    silent: "passed-only",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
    // Calendar math is local-time math; pin a zone with a DST change.
    env: { TZ: "America/Toronto" },
  },
});
