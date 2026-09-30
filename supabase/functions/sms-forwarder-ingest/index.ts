// sms-forwarder-ingest — receives raw MoMo SMS from the Welile SMS Forwarder
// Android app.  PHASE 1 (shadow): stores + parses + compares against
// gmail_transactions.  It NEVER credits, debits or approves anything; the
// phone forwards evidence, the server decides (see docs/HANDOVER/171).
//
// Auth: `Authorization: Bearer <device token>`; only sha256(token) is stored in
// sms_forwarder_devices.  Deployed with verify_jwt = false (config.toml).
//
// POST { action: "upload",    messages: [{client_message_id, sender, body, received_at_ms, sim_slot?}] }
//   -> { ok, acked: [client_message_id...] }   (ack = durably stored, safe to delete on phone)
// POST { action: "heartbeat", battery_pct?, app_version?, pending_count?, ... }
//   -> { ok, server_time }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { parseTransaction, sha256Hex } from "../_shared/txnParser.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MAX_BATCH = 50;
const MAX_BODY = 2000;
/** A phone-parsed row is only called `phone_only` once Gmail has had this long to ingest it. */
const GMAIL_LAG_MS = 10 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (token.length < 32) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: device } = await supabase
    .from("sms_forwarder_devices").select("id, active")
    .eq("token_hash", await sha256Hex(token)).maybeSingle();
  if (!device || !device.active) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  const nowIso = new Date().toISOString();

  if (body?.action === "heartbeat") {
    await supabase.from("sms_forwarder_devices").update({
      last_seen_at: nowIso,
      last_battery_pct: Number.isFinite(body.battery_pct) ? Math.round(body.battery_pct) : null,
      last_app_version: typeof body.app_version === "string" ? body.app_version.slice(0, 32) : null,
      last_pending_count: Number.isFinite(body.pending_count) ? Math.round(body.pending_count) : null,
      last_heartbeat: body,
    }).eq("id", device.id);
    await sweepComparisons(supabase);
    return json({ ok: true, server_time: nowIso });
  }

  if (body?.action !== "upload" || !Array.isArray(body.messages)) {
    return json({ ok: false, error: "bad_request" }, 400);
  }
  if (body.messages.length > MAX_BATCH) return json({ ok: false, error: "batch_too_large", max: MAX_BATCH }, 413);

  const acked: string[] = [];
  const failed: { id: string; error: string }[] = [];

  for (const m of body.messages) {
    const cid = typeof m?.client_message_id === "string" ? m.client_message_id.slice(0, 128) : "";
    const text = typeof m?.body === "string" ? m.body.slice(0, MAX_BODY) : "";
    const sender = typeof m?.sender === "string" ? m.sender.slice(0, 64) : "";
    const ts = Number(m?.received_at_ms);
    if (!cid || !text || !sender || !Number.isFinite(ts)) { failed.push({ id: cid || "?", error: "invalid" }); continue; }

    const p = parseTransaction(text);
    const isParsed = !!(p.amount || p.transaction_id);
    let comparison: string = isParsed ? "pending" : (p.amount === undefined && !p.transaction_id ? "not_transaction" : "unparsed");
    let matchedRowId: string | null = null;
    if (p.transaction_id) {
      const { data: g } = await supabase.from("gmail_transactions").select("id")
        .ilike("transaction_id", p.transaction_id).limit(1).maybeSingle();
      if (g) { comparison = "matched_gmail"; matchedRowId = (g as any).id; }
    }

    const { error } = await supabase.from("sms_forwarder_messages").insert({
      device_id: device.id, client_message_id: cid, sender, body: text,
      sms_received_at: new Date(ts).toISOString(), sim_slot: Number.isInteger(m.sim_slot) ? m.sim_slot : null,
      parsed: isParsed, amount: p.amount ?? null, transaction_id: p.transaction_id ?? null,
      direction: p.direction ?? null, channel: p.channel ?? null,
      counterparty: p.counterparty ?? null, counterparty_name: p.counterparty_name ?? null,
      fee: p.fee ?? null, balance: p.balance ?? null,
      comparison, matched_gmail_row_id: matchedRowId,
      compared_at: comparison === "pending" ? null : nowIso,
    });
    // 23505 = retry of a message we already hold -> still an ack (idempotent).
    if (!error || (error as any).code === "23505") acked.push(cid);
    else failed.push({ id: cid, error: error.message });
  }

  await supabase.from("sms_forwarder_devices").update({ last_seen_at: nowIso }).eq("id", device.id);
  await sweepComparisons(supabase);
  return json({ ok: true, acked, failed });
});

/** Settle `pending` rows once Gmail has had time to ingest the same TID. */
async function sweepComparisons(supabase: // deno-lint-ignore no-explicit-any
  any) {
  try {
    const { data: rows } = await supabase.from("sms_forwarder_messages")
      .select("id, transaction_id, uploaded_at").eq("comparison", "pending")
      .order("uploaded_at", { ascending: true }).limit(100);
    for (const r of (rows ?? []) as any[]) {
      let matched: string | null = null;
      if (r.transaction_id) {
        const { data: g } = await supabase.from("gmail_transactions").select("id")
          .ilike("transaction_id", r.transaction_id).limit(1).maybeSingle();
        matched = (g as any)?.id ?? null;
      }
      const aged = Date.now() - Date.parse(r.uploaded_at) > GMAIL_LAG_MS;
      if (!matched && !aged) continue;
      await supabase.from("sms_forwarder_messages").update({
        comparison: matched ? "matched_gmail" : "phone_only",
        matched_gmail_row_id: matched, compared_at: new Date().toISOString(),
      }).eq("id", r.id);
    }
  } catch (e) {
    console.warn("[sms-forwarder-ingest] comparison sweep failed (non-fatal):", e);
  }
}
