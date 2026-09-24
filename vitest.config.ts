import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    /* test-guard refuses to let any file run against a non-test database; it
       runs in every worker, so a new suite that reaches for ./db.js directly
       is covered without its author having to remember anything. */
    setupFiles: ["./src/test/setup.ts", "./server/test-guard.ts"],
    // Server tests opt into the node environment per file with a
    // `@vitest-environment node` docblock; the jsdom default still applies to src/.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.{test,spec}.ts"],
    /* server/config.ts fails fast on these at IMPORT time, which is correct for
       the real server and inconvenient for a unit test that only wants a type or
       a pure function. Dummy values let those modules load; no unit test opens a
       connection.

       The integration suites resolve their real connection through
       server/test-db.ts, which reads TEST_DATABASE_URL or .env.test and
       REFUSES anything that is not a test database. They used to read
       .env.local instead and overwrite this value with the development url —
       which is how the whole suite came to run against `nerve`. */
    env: {
      DATABASE_URL: "postgres://nerve_test:nerve_test@127.0.0.1:5432/nerve_test",
      SESSION_SECRET: "test-session-secret-not-used-for-anything-real",
      SUPER_ADMIN_PASSWORD: "test-bootstrap-password",
      /* Each worker opens its own pool; the pg default of 10 times a machine's
         worth of workers exhausts a 100-connection server, and a suite that
         cannot connect SKIPS rather than fails. See server/db.ts. */
      PG_POOL_MAX: "6",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
