import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.node,
      ecmaVersion: "latest",
      sourceType: "module", // change to "commonjs" if not using ESM
    },
    rules: {
      "no-unused-vars": "warn",
      "no-console": "off",
      "no-undef": "error",
      semi: ["error", "always"],
      quotes: ["off"],
    },
  },
]);
