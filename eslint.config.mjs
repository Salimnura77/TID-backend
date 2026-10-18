import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "dist-test/**", "node_modules/**", ".cache/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
      "@typescript-eslint/no-explicit-any": "error"
    }
  }
);
