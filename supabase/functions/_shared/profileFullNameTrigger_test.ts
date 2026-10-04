import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assertEquals,
  assertExists,
  assertNotEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  FULL_NAME_ERROR,
  mapProfileFullNameDbError,
} from "./validateFullName.ts";

/**
 * Integration test: verifies the public.enforce_profile_full_name() trigger
 * rejects blank / whitespace-only / too-short full_name values on BOTH
 * INSERT and UPDATE, and that the resulting Postgres error maps cleanly
 * to the canonical client-facing FULL_NAME_ERROR via mapProfileFullNameDbError.
 *
 * Runs directly against the database with the service-role key, bypassing
 * RLS and any edge-function pre-validation, so we are exclusively exercising
 * the database-layer guarantee.
 */

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? Deno.env.get("VITE_SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

// If the service role key isn't available in this environment, skip the
// suite cleanly rather than failing — the unit + edge-function tests still
// cover the same contract from the other side.
const skipReason = !SERVICE_ROLE_KEY
  ? "SUPABASE_SERVICE_ROLE_KEY not available; skipping DB trigger integration tests"
  : null;

const admin = SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// Track every auth user we create so we can clean up after the suite.
const createdUserIds: string[] = [];

async function createTempAuthUser(): Promise<string> {
  // Phone-only user — no email confirmation required, easy to clean up.
  const phone = `+25670${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`;
  const { data, error } = await admin!.auth.admin.createUser({
    phone,
    phone_confirm: true,
    user_metadata: { full_name: "Trigger Test User" },
  });
  if (error || !data.user) {
    throw new Error(`Failed to create temp auth user: ${error?.message}`);
  }
  createdUserIds.push(data.user.id);
  return data.user.id;
}

async function deleteProfileRow(userId: string) {
  await admin!.from("profiles").delete().eq("id", userId);
}

async function cleanupUser(userId: string) {
  await deleteProfileRow(userId);
  await admin!.auth.admin.deleteUser(userId).catch(() => {});
}

// --- INSERT cases ---------------------------------------------------------

const INSERT_CASES: Array<{ label: string; value: unknown }> = [
  { label: "empty string", value: "" },
  { label: "single space", value: " " },
  { label: "multiple whitespace", value: "   \t\n " },
  { label: "single character", value: " a " },
  { label: "null", value: null },
];

for (const c of INSERT_CASES) {
  Deno.test({
    name: `DB trigger rejects INSERT with ${c.label} full_name`,
    ignore: !!skipReason,
    async fn() {
      const userId = await createTempAuthUser();
      try {
        // The auth-user trigger likely created a profile already; clear it
        // so we can attempt a fresh insert with the bad value.
        await deleteProfileRow(userId);

        const { data, error } = await admin!
          .from("profiles")
          .insert({ id: userId, full_name: c.value as string | null })
          .select()
          .maybeSingle();

        assertEquals(data, null, "trigger must block the insert");
        assertExists(error, "expected a Postgres error from the trigger");
        const friendly = mapProfileFullNameDbError(error);
        assertEquals(
          friendly,
          FULL_NAME_ERROR,
          `expected FULL_NAME_ERROR, got: ${friendly} (raw: ${error.message})`,
        );
      } finally {
        await cleanupUser(userId);
      }
    },
  });
}

// --- UPDATE cases ---------------------------------------------------------

const UPDATE_CASES: Array<{ label: string; value: unknown }> = [
  { label: "empty string", value: "" },
  { label: "whitespace only", value: "    " },
  { label: "single character", value: "x" },
];

for (const c of UPDATE_CASES) {
  Deno.test({
    name: `DB trigger rejects UPDATE that sets full_name to ${c.label}`,
    ignore: !!skipReason,
    async fn() {
      const userId = await createTempAuthUser();
      try {
        // Ensure a valid baseline profile exists.
        await admin!
          .from("profiles")
          .upsert({ id: userId, full_name: "Baseline User" }, { onConflict: "id" });

        const { data, error } = await admin!
          .from("profiles")
          .update({ full_name: c.value as string | null })
          .eq("id", userId)
          .select()
          .maybeSingle();

        assertEquals(data, null, "trigger must block the update");
        assertExists(error, "expected a Postgres error from the trigger");
        const friendly = mapProfileFullNameDbError(error);
        assertEquals(friendly, FULL_NAME_ERROR);

        // Confirm the baseline value was NOT overwritten.
        const { data: still } = await admin!
          .from("profiles")
          .select("full_name")
          .eq("id", userId)
          .maybeSingle();
        assertEquals(still?.full_name, "Baseline User");
      } finally {
        await cleanupUser(userId);
      }
    },
  });
}

// --- HAPPY PATH: trimming + acceptance -----------------------------------

Deno.test({
  name: "DB trigger accepts a valid name and trims/normalizes whitespace",
  ignore: !!skipReason,
  async fn() {
    const userId = await createTempAuthUser();
    try {
      await deleteProfileRow(userId);

      const { data, error } = await admin!
        .from("profiles")
        .insert({ id: userId, full_name: "  Jane   Doe  " })
        .select("full_name")
        .maybeSingle();

      assertEquals(error, null, `unexpected error: ${error?.message}`);
      assertExists(data);
      // Trigger should normalize whitespace identically to the client/edge
      // validator: trim ends + collapse runs of whitespace.
      assertEquals(data.full_name, "Jane Doe");
    } finally {
      await cleanupUser(userId);
    }
  },
});

Deno.test({
  name: "DB trigger accepts an UPDATE that sets a valid name (with trimming)",
  ignore: !!skipReason,
  async fn() {
    const userId = await createTempAuthUser();
    try {
      await admin!
        .from("profiles")
        .upsert({ id: userId, full_name: "Baseline User" }, { onConflict: "id" });

      const { data, error } = await admin!
        .from("profiles")
        .update({ full_name: "   Mary\tJane    Watson  " })
        .eq("id", userId)
        .select("full_name")
        .maybeSingle();

      assertEquals(error, null, `unexpected error: ${error?.message}`);
      assertExists(data);
      assertEquals(data.full_name, "Mary Jane Watson");
      assertNotEquals(data.full_name, "Baseline User");
    } finally {
      await cleanupUser(userId);
    }
  },
});

// --- Best-effort safety net: cleanup any leaked test users ---------------

Deno.test({
  name: "cleanup: remove any temp users created during this test run",
  ignore: !!skipReason,
  async fn() {
    for (const id of createdUserIds) {
      try { await admin!.from("profiles").delete().eq("id", id); } catch { /* ignore */ }
      try { await admin!.auth.admin.deleteUser(id); } catch { /* ignore */ }
    }
  },
});