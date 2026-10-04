import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Integration test: verifies the public.sync_proxy_agent_capabilities()
 * trigger correctly grants and revokes `act_as_proxy` and
 * `capture_supporters` capabilities based on the lifecycle of
 * proxy_agent_assignments rows.
 *
 * Strategy: the database exposes a SECURITY DEFINER test harness RPC
 * `_test_proxy_capability_sync()` that runs the full trigger lifecycle
 * inside a savepoint and returns a per-step pass/fail report. All writes
 * are rolled back automatically. This keeps the test fast, hermetic and
 * self-cleaning regardless of which agent/beneficiaries are picked.
 *
 * The test runs against the project DB. It prefers the service-role key
 * (skips RLS entirely) and falls back to the publishable/anon key + RPC
 * permissions (the RPC itself enforces staff-only access).
 */

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY =
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
  Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ??
  Deno.env.get("VITE_SUPABASE_ANON_KEY");

// Service-role gives the RPC unconditional access. With anon key, the RPC
// will reject the call (auth.role() != service_role and no staff JWT) — so
// in that environment we skip.
const skipReason = !SERVICE_ROLE_KEY
  ? "SUPABASE_SERVICE_ROLE_KEY not available; skipping proxy-capability trigger integration tests"
  : null;

const admin =
  SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : ANON_KEY
      ? createClient(SUPABASE_URL, ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

type TestRow = { test_name: string; passed: boolean; detail: string };

Deno.test({
  name:
    "proxy capability sync — full lifecycle (insert/approve/dup/deactivate/reject/delete)",
  ignore: !!skipReason,
  async fn() {
    const { data, error } = await admin!.rpc("_test_proxy_capability_sync");
    if (error) throw new Error(`RPC failed: ${error.message}`);

    const rows = (data ?? []) as TestRow[];
    assert(rows.length >= 9, `expected lifecycle test rows, got ${rows.length}`);

    const failures = rows.filter((r) => !r.passed);
    if (failures.length > 0) {
      const summary = failures
        .map((f) => `  ✗ ${f.test_name}: ${f.detail}`)
        .join("\n");
      throw new Error(`Trigger contract violations:\n${summary}`);
    }

    // Sanity: a few critical checks must be present and passing.
    const must = [
      "T1_clean_slate",
      "T3_approve_activate_grants_both",
      "T6_deactivate_last_revokes",
      "T8_rejected_status_revokes",
      "T9_delete_revokes",
      "T10_default_kit_excludes_capture_supporters",
      "T11_default_kit_excludes_act_as_proxy",
      "T12_sync_trigger_installed",
      "T13_unique_constraint_present",
    ];
    for (const name of must) {
      const row = rows.find((r) => r.test_name === name);
      assert(row, `missing required check: ${name}`);
      assertEquals(row!.passed, true, `${name}: ${row!.detail}`);
    }
  },
});