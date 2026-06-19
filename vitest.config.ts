import { defineConfig } from "vitest/config";
import { tsMacrosPlugin } from "./vite-ts-macros-plugin";

export default defineConfig({
  plugins: [tsMacrosPlugin()],
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts"],
    // Run tests sequentially to avoid races on the shared debug log file.
    fileParallelism: false,
  },
});
