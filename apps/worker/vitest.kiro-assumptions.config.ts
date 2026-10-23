import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/compat/kiro/assumptions/**/*.test.ts"] },
});
