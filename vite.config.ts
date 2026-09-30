import { recommended } from "@effect/tsgo/oxlint-presets";
import { defineConfig } from "vite-plus";

const toolingIgnores = ["tools/oxlint/anti-slop/**"];

export default defineConfig({
  fmt: { ignorePatterns: toolingIgnores },
  lint: {
    extends: [recommended],
    ignorePatterns: toolingIgnores,
    options: { typeAware: true, typeCheck: true, denyWarnings: true },
    jsPlugins: [
      { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
      { name: "anti-slop-effect", specifier: "./tools/oxlint/anti-slop/effect/index.ts" },
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*"],
              allowImportNames: ["createServer"],
              message:
                "Use Effect platform services where they cover the need. The createServer exception is for explicit HTTP boundaries.",
            },
          ],
        },
      ],
      "oxc/no-accumulating-spread": "error",
      "anti-slop/no-array-filter-map": "error",
      "anti-slop/no-reduce-accumulator-copy": "error",
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-readable-spacing": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
      "anti-slop-effect/no-manual-effect-error-tag": "error",
      "anti-slop-effect/no-manual-tag-comparison": "error",
      "anti-slop-effect/no-manual-tagged-construction": "error",
      "anti-slop-effect/no-service-constructor-imports": "error",
      "anti-slop-effect/prefer-effect-match": "error",
    },
  },
  pack: {
    format: "esm",
    outExtensions: () => ({ js: ".mjs" }),
    platform: "neutral",
    target: "esnext",
    deps: { alwaysBundle: [/./], onlyBundle: false },
    define: { "import.meta.env": "{}" },
    clean: false,
  },
});
