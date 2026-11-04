import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "https://deno.land/x/zod@v3.23.8/mod.ts": "zod/v3",
      "https://esm.sh/@supabase/supabase-js@2.49.1": "@supabase/supabase-js",
    },
  },
});