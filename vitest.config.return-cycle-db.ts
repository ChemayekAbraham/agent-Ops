import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config";

/**
 * Config for the Partner Return cycle guard database suite ONLY (`npm run test:return-cycle-db`).
 * Makes a closed gate FAIL instead of skipping (a skipped suite reports as a pass). It does not cause a connection:
 * the suite still requires RETURN_CYCLE_DB_URL on localhost, a database named rcg_test_*, an empty database and
 * RETURN_CYCLE_TEST_ISOLATED_DB=1. Never point it at a shared or production database.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      env: { RETURN_CYCLE_DB_TESTS_REQUIRED: "1" },
      fileParallelism: false,
    },
  }),
);
