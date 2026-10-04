import "https://deno.land/std@0.224.0/dotenv/load.ts";
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { FULL_NAME_ERROR } from "../_shared/validateFullName.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const FN_URL = `${SUPABASE_URL}/functions/v1/register-proxy-funder`;

/**
 * Integration tests against the deployed register-proxy-funder edge function.
 *
 * This function is the cleanest entry point for verifying the backend
 * full-name validation contract because:
 *   - it does not require a caller JWT,
 *   - phone + agent_id are validated BEFORE the name check,
 *   - the name check uses the same shared validator the DB trigger mirrors.
 *
 * For invalid names we expect HTTP 400 + the canonical FULL_NAME_ERROR
 * message — the same string the client form and the DB trigger surface.
 * For valid-but-unauthorized agent IDs we expect the request to pass the
 * name check and fail later (auth / FK / phone-uniqueness), proving the
 * trimmed name was accepted.
 */
async function callRegister(payload: Record<string, unknown>) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
      "apikey": SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Use a throwaway phone per test run to avoid colliding with prior runs
function uniquePhone() {
  // Last 9 digits, prefixed with 7 → looks like a Ugandan mobile
  const tail = String(Date.now()).slice(-8);
  return `7${tail}`;
}

const FAKE_AGENT_ID = "00000000-0000-0000-0000-000000000000";

Deno.test("rejects empty full_name with canonical message", async () => {
  const { status, json } = await callRegister({
    full_name: "",
    phone: uniquePhone(),
    agent_id: FAKE_AGENT_ID,
  });
  assertEquals(status, 400);
  assertEquals(json.error, FULL_NAME_ERROR);
});

Deno.test("rejects whitespace-only full_name", async () => {
  const { status, json } = await callRegister({
    full_name: "     ",
    phone: uniquePhone(),
    agent_id: FAKE_AGENT_ID,
  });
  assertEquals(status, 400);
  assertEquals(json.error, FULL_NAME_ERROR);
});

Deno.test("rejects single-character full_name", async () => {
  const { status, json } = await callRegister({
    full_name: " a ",
    phone: uniquePhone(),
    agent_id: FAKE_AGENT_ID,
  });
  assertEquals(status, 400);
  assertEquals(json.error, FULL_NAME_ERROR);
});

Deno.test("rejects null full_name", async () => {
  const { status, json } = await callRegister({
    full_name: null,
    phone: uniquePhone(),
    agent_id: FAKE_AGENT_ID,
  });
  assertEquals(status, 400);
  assertEquals(json.error, FULL_NAME_ERROR);
});

Deno.test("rejects missing full_name field", async () => {
  const { status, json } = await callRegister({
    phone: uniquePhone(),
    agent_id: FAKE_AGENT_ID,
  });
  assertEquals(status, 400);
  assertEquals(json.error, FULL_NAME_ERROR);
});

Deno.test("accepts a valid full_name (passes the name gate)", async () => {
  // The fake agent_id won't satisfy downstream FK/auth constraints, so we
  // expect the request to proceed PAST the name check and fail later — i.e.
  // we should NOT get the FULL_NAME_ERROR back.
  const { status, json } = await callRegister({
    full_name: "  Jane   Doe  ",
    phone: uniquePhone(),
    agent_id: FAKE_AGENT_ID,
  });
  assertExists(json);
  // Whatever happens next, it must not be the name validation error.
  if (status === 400) {
    assertEquals(
      json.error === FULL_NAME_ERROR,
      false,
      `Valid name "Jane Doe" was wrongly rejected by name validator: ${json.error}`,
    );
  }
});