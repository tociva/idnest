import nx from "@nx/eslint-plugin";
import tseslint from "typescript-eslint";

/**
 * Workspace base ESLint config (flat config, TypeScript).
 *
 * Composes the Nx base/TS/JS rule sets, the typescript-eslint recommended
 * rules, and the Nx module-boundary rule (so apps may only depend on the
 * shared library, not on each other). Per-project `eslint.config.ts` files
 * extend this.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "**/node_modules",
      "**/.nx",
      "**/.angular",
      "**/coverage",
      "**/vite.config.*.timestamp*",
      "**/vitest.config.*.timestamp*",
    ],
  },
  ...nx.configs["flat/base"],
  ...nx.configs["flat/typescript"],
  ...nx.configs["flat/javascript"],
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.cts", "**/*.mts", "**/*.js", "**/*.jsx", "**/*.mjs"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          enforceBuildableLibDependency: true,
          allow: ["^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$"],
          depConstraints: [
            { sourceTag: "scope:shared", onlyDependOnLibsWithTags: ["scope:shared"] },
            { sourceTag: "scope:auth", onlyDependOnLibsWithTags: ["scope:auth", "scope:shared"] },
            {
              sourceTag: "type:app",
              onlyDependOnLibsWithTags: ["type:types", "type:util", "type:data", "type:server"],
            },
            { sourceTag: "platform:browser", notDependOnLibsWithTags: ["type:server"] },
            { sourceTag: "type:types", onlyDependOnLibsWithTags: ["type:types"] },
            { sourceTag: "*", onlyDependOnLibsWithTags: ["*"] },
          ],
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // The flat config files legitimately import the workspace base config by
    // relative path; that is not an app/lib boundary violation.
    files: ["**/eslint.config.{ts,js,cjs,mjs}"],
    rules: {
      "@nx/enforce-module-boundaries": "off",
    },
  },
  {
    // Non-null assertions are idiomatic in test fixtures.
    files: ["**/*.test.ts", "**/*.spec.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
