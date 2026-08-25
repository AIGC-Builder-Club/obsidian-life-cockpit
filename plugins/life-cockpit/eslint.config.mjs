import tseslint from "typescript-eslint";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    ignores: ["main.js", "node_modules/**", "test/.build/**", "*.mjs"],
  },
  ...tseslint.configs.recommended,
  {
    // **.tsx 也要进来。** 0.12.0 那一版只写了 `**/*.ts`，
    // 于是整张 React 页（`src/ui/dashboard/`）一行都没被 lint 过——
    // 一个只覆盖一半源码的 lint，比没有 lint 更容易让人放心。
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.json" },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
]);
