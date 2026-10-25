// ESLint flat config — GraveYield Protocol TS workspaces (sdk, indexer, ops,
// adversary). Phase 1 (build/reliability): the repo previously enforced lint
// on the Rust side only (cargo clippy -D warnings); the TS side had no lint
// gate at all. This config is check-only (no formatting rules — prettier owns
// formatting, eslint-config-prettier disables overlapping rules).
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/target/**", "**/node_modules/**", "**/.next/**", "**/*.gen.ts"],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // `_`-prefixed params/vars are the repo's intentional-unused convention
      // (e.g. sdk/test/fakeRpc.ts RPC stubs that must match the real
      // signature); rest-sibling omission (`const { integrity, ...rest }`)
      // is the standard TS omit idiom used by ops artifact tests.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
      // `Phase2Input extends Phase1Input {}` (sdk/src/client.ts) is a
      // deliberate empty marker interface: it keeps Phase2Input a named,
      // documented type in the published SDK surface without aliasing it
      // to Phase1Input (which would erode the docs and the identity of
      // the two input shapes). allowInterfaces only lifts the
      // interface-extends case, not empty object types in general.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
    },
  },
);
