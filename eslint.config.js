// ESLint flat config for the plugin source.
// Biome handles formatting (biome format); ESLint handles the
// stricter TypeScript rules below.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/**",
      ".transformed/**",
      "debugLog.macro.ts",
      "vite-ts-macros-plugin.ts",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "interface"],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression[typeAnnotation.type='TSAnyKeyword']",
          message: 'Do not use "as any" assertions.',
        },
        {
          selector: "TSAsExpression[typeAnnotation.type='TSUnknownKeyword']",
          message: 'Do not use "as unknown" assertions.',
        },
        {
          selector: "TSTypeAssertion[typeAnnotation.type='TSAnyKeyword']",
          message: 'Do not use "<any>" type assertions.',
        },
        {
          selector: "TSTypeAssertion[typeAnnotation.type='TSUnknownKeyword']",
          message: 'Do not use "<unknown>" type assertions.',
        },
        {
          selector: "TSTypeAnnotation > TSTypeLiteral",
          message: "Do not use inline object type literals. Extract to a named type or interface.",
        },
        {
          selector: "TSTypeParameterInstantiation > TSTypeLiteral",
          message: "Do not use inline object type literals in type arguments. Extract to a named type or interface.",
        },
        {
          selector: "TSTypeAnnotation > TSTupleType",
          message: "Do not use inline tuple types. Extract to a named type.",
        },
        {
          selector: "TSTypeParameterInstantiation > TSTupleType",
          message: "Do not use inline tuple types in type arguments. Extract to a named type.",
        },
      ],
    },
  },
);
