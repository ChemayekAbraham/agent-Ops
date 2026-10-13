// Route-only wrapper for the Bucket A posting RPC.
// It exists solely to lift the 8s `authenticated` statement timeout. It does NOT
// re-implement any check: it verifies the caller's JWT, then calls the unchanged
// `public.cfo_bucket_a_post` AS THAT USER (role `authenticated`, auth.uid() = caller),
// so every server safeguard inside the function still applies.
import postgres from "npm:postgres@3.4.4";
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "not_authenticated" }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: "not_authenticated" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const { p_preflight_id, p_package_hash, p_confirmation } = body ?? {};
  if (typeof p_preflight_id !== "string" || !UUID.test(p_preflight_id) ||
      typeof p_package_hash !== "string" || p_package_hash.length > 200 ||
      typeof p_confirmation !== "string" || p_confirmation.length > 200) {
    return json({ error: "bad_request" }, 400);
  }

  const claims = JSON.stringify({ sub: u.user.id, role: "authenticated", email: u.user.email ?? null });
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { max: 1, prepare: false });
  try {
    const result = await sql.begin(async (tx) => {
      await tx`select set_config('statement_timeout', '180s', true)`;
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx`select set_config('request.jwt.claim.sub', ${u.user.id}, true)`;
      await tx.unsafe("set local role authenticated");
      const r = await tx`select public.cfo_bucket_a_post(${p_preflight_id}::uuid, ${p_package_hash}, ${p_confirmation}) as res`;
      return r[0].res;
    });
    return json({ data: result });
  } catch (e) {
    return json({ error: (e as Error).message ?? "posting_failed" }, 400);
  } finally {
    await sql.end({ timeout: 5 });
  }
});
