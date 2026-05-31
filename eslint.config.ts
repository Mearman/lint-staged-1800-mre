import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import { configs } from "typescript-eslint";
import grandchildPlugin from "./eslint-plugin-grandchild.cjs";

export default defineConfig(
  { ignores: ["dist/", "node_modules/"] },
  {
    files: ["**/*.ts"],
    extends: [eslint.configs.recommended, ...configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      grandchild: grandchildPlugin,
    },
    rules: {
      "grandchild/spawn-grandchild": "error",
    },
  }
);
