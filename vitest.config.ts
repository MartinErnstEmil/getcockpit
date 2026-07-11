import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Paralleles vitest crasht auf Windows reproduzierbar: esbuilds
    // Transform-Service stirbt unter Last mit Go-Panic ("The service is no
    // longer running"), keine Testlogik. Ein Fork ohne Datei-Parallelität
    // macht `npm test` zum verlässlichen Grün-Gate (~22 s statt ~10 s).
    pool: "forks",
    fileParallelism: false,
    poolOptions: { forks: { singleFork: true } },
  },
});
