import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "../../node_modules/.vite/admin-frontend",
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
