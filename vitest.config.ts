import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Server tests opt into the node environment per file with a
    // `@vitest-environment node` docblock; the jsdom default still applies to src/.
    include: ["src/**/*.{test,spec}.{ts,tsx}", "server/**/*.{test,spec}.ts"],
    /* server/config.ts fails fast on these at IMPORT time, which is correct for
       the real server and inconvenient for a unit test that only wants a type or
       a pure function. Dummy values let those modules load; no unit test opens a
       connection, and the integration tests override DATABASE_URL from .env.local. */
    env: {
      DATABASE_URL: "postgres://nerve_test:nerve_test@127.0.0.1:5432/nerve_test",
      SESSION_SECRET: "test-session-secret-not-used-for-anything-real",
      SUPER_ADMIN_PASSWORD: "test-bootstrap-password",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
