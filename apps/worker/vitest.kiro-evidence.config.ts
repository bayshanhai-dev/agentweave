import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["tests/compat/kiro/evidence/**/*.test.ts"] },
});
