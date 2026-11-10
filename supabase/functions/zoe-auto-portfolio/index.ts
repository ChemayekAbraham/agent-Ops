// zoe-auto-portfolio (PRACTICE BUILD). Approved by Benjamin 10 Nov 2026 7:26 PM EAT: practice mode only.
//
// Drains zoe_auto_portfolio_inbox (filled by the deposit_requests trigger) every 5 minutes via pg_cron.
// For each approved float credit it calls zoe_record_decision, which writes ONLY its own
// zoe_auto_portfolio_log row and, for any non-create outcome, a zoe_portfolio_review_queue row.
//
// This build has NO live path: it never sends an agreement, never calls
// zoe_create_portfolio_from_deposit, never posts to the ledger and never messages anyone, even if
// settings.mode were set to 'live'. Going live needs a new approval and a new build.

import { createClient } from "npm:@supabase/supabase-js@2";
import { requireServiceRole } from "../_shared/requireServiceRole.ts";

const corsHeaders = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const BATCH = 25;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: s, error: sErr } = await admin.from("zoe_auto_portfolio_settings").select("enabled, mode").eq("id", true).single();
  if (sErr) return Response.json({ ok: false, error: "settings_unreadable" }, { status: 500 });
  if (!s?.enabled) return Response.json({ ok: true, skipped: "disabled" });
  // Practice build: always record as practice, whatever the settings say.
  const mode = "practice";

  const { data: inbox, error: iErr } = await admin.from("zoe_auto_portfolio_inbox")
    .select("deposit_request_id").is("done_at", null).order("enqueued_at").limit(BATCH);
  if (iErr) return Response.json({ ok: false, error: "inbox_unreadable" }, { status: 500 });

  const results: unknown[] = [];
  for (const row of inbox ?? []) {
    const depositId = row.deposit_request_id as string;
    await admin.from("zoe_auto_portfolio_inbox").update({ picked_at: new Date().toISOString() }).eq("deposit_request_id", depositId);
    const { data: ev, error } = await admin.rpc("zoe_record_decision", { p_deposit_id: depositId, p_mode: mode });
    if (error) {
      await admin.from("zoe_auto_portfolio_inbox").update({ last_error: error.message.slice(0, 500) }).eq("deposit_request_id", depositId);
      results.push({ depositId, error: error.message });
      continue; // stays in the inbox for the next run
    }
    await admin.from("zoe_auto_portfolio_inbox").update({ done_at: new Date().toISOString(), last_error: null }).eq("deposit_request_id", depositId);
    results.push({ depositId, decision: ev?.decision, reason: ev?.reason ?? null, amount: ev?.amount ?? null });
  }
  return Response.json({ ok: true, mode, settings_mode: s.mode, processed: results.length, results });
});
