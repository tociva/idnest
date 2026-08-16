import { defineConfig } from "vitest/config";

export default defineConfig({
  cacheDir: "../../node_modules/.vite/server-runtime",
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
  },
});
