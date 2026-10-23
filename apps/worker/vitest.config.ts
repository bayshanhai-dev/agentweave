import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: ["tests/compat/kiro/assumptions/**", "**/node_modules/**", "**/dist/**"],
  },
});
