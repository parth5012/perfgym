import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@perfgym/core": resolve(__dirname, "packages/core/src/index.ts"),
      "@perfgym/cli": resolve(__dirname, "packages/cli/src/index.ts"),
      "@perfgym/linter": resolve(__dirname, "packages/linter/src/index.ts"),
      "@perfgym/adapter-web": resolve(__dirname, "packages/adapters/web/src/index.ts"),
    },
  },
  test: {
    // Scratch space (.tmp/) holds demo sandbox repos and agent artifacts —
    // never let its fixture files be collected as real tests.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.tmp/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
    ],
  },
  build: {
    target: "node20",
    ssr: true,
    lib: {
      entry: {
        cli: resolve(__dirname, "packages/cli/src/index.ts"),
        core: resolve(__dirname, "packages/core/src/index.ts"),
        linter: resolve(__dirname, "packages/linter/src/index.ts"),
        "adapter-web": resolve(__dirname, "packages/adapters/web/src/index.ts")
      },
      formats: ["es"]
    },
    rollupOptions: {
      external: [
        "child_process",
        "fs",
        "fs/promises",
        "path",
        "os",
        "events",
        "util",
        "commander",
        "yaml",
        "zod",
        "chalk"
      ]
    }
  }
});
