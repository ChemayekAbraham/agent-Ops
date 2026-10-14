import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Config for the Food M1 database integration suites ONLY, loaded by
 * `npm run test:food-db` via --config. Everything else keeps vitest.config.ts.
 *
 * WHY THIS FILE EXISTS. A skipped vitest suite reports as a PASS. The Food
 * gate therefore throws instead of skipping when FOOD_DB_TESTS_REQUIRED=1 —
 * but nothing set that variable, so the command the harness itself named as
 * canonical could close the gate, skip all three suites, and exit zero. An
 * operator following the instructions would have seen green having executed
 * no SQL at all.
 *
 * WHY NOT SET IT IN THE SCRIPT. `FOOD_DB_TESTS_REQUIRED=1 vitest ...` is POSIX
 * shell syntax. npm runs scripts through cmd.exe on Windows, where that form
 * fails outright, and this project is developed on Windows. The usual fix is
 * cross-env, which would add a dependency. `test.env` is a first-class vitest
 * setting that works identically on every platform and adds nothing.
 *
 * THIS DOES NOT CAUSE A CONNECTION. It only removes the suites' permission to
 * skip quietly. Every connection precondition in openGate still applies — in
 * particular PGHOST, RACE_TEST_ISOLATED_DB=1 and the FOOD_DB_SESSION_MODE
 * guard — and a closed gate now fails the run instead of passing it.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { FOOD_DB_TESTS_REQUIRED: "1" },
      // These suites share global fixtures (one coordinator seat, eight fixed
      // identities), so they must not run concurrently with each other.
      fileParallelism: false,
    },
  }),
);
