import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    root,
    include: ["passing.fixture.ts"],
    globalSetup: ["./global-setup.ts"],
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 5_000,
    hookTimeout: 5_000,
  },
});
