import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
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
