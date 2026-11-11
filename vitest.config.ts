import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

/**
 * Node 25+ turns on its own Web Storage: a global `localStorage` that, without
 * --localstorage-file, is undefined. It shadows jsdom's, so tests calling
 * localStorage.clear() fail with "Cannot read properties of undefined".
 * Turning it off in the test workers gives the tests jsdom's localStorage
 * again, on every platform, with no NODE_OPTIONS to set by hand. Node 22-24
 * keep Web Storage off by default, and Node 20 does not know the flag, so it
 * is only passed on 25 and later.
 */
const nodeMajor = Number(process.versions.node.split(".")[0]);
const workerExecArgv = nodeMajor >= 25 ? ["--no-experimental-webstorage"] : [];

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    // The default "forks" pool; the food-db and return-cycle-db configs extend this one.
    pool: "forks",
    poolOptions: {
      forks: { execArgv: workerExecArgv },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "https://deno.land/x/zod@v3.23.8/mod.ts": "zod/v3",
      "https://esm.sh/@supabase/supabase-js@2.49.1": "@supabase/supabase-js",
    },
  },
});
