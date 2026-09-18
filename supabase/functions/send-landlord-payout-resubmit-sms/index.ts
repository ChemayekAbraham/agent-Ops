// ONE-OFF: tell the agents behind seven specific tenants to (re)submit their
// landlord payout withdrawal. Recipients and wording are fixed in this file on
// purpose — it is not a general broadcast tool. Delete it after the send.
//
// Safe by default: a call without { "confirm": true } only reports what it
// WOULD send. Each agent is texted at most once (idempotency key per agent), so
// re-running after a partial failure only retries the ones that did not go.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendSMS, formatPhoneInternational } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const CLOSED =
  "Welile: Your landlord payout request for {who} was closed by mistake and cannot be reopened. " +
  "Please open Landlord Ops and submit the withdrawal again now so a merchant agent can pay it. " +
  "Your float was not deducted.";
const APPROVED =
  "Welile: Your landlord payout for {who} is approved to be paid by a merchant agent. " +
  "Please open Landlord Ops and submit the withdrawal now.";

const RECIPIENTS: { agent_id: string; name: string; template: string; who: string }[] = [
  { agent_id: "5295252d-f477-42a9-92f5-af56e503e33d", name: "Janehephzibar Gimono", template: CLOSED, who: "Kulubya Simon (UGX 270,000)" },
  { agent_id: "86e49297-9bd1-42e3-94d5-d6b380595ae0", name: "Emmanuel Waswa Ssesanga", template: CLOSED, who: "Ronald (UGX 450,000)" },
  { agent_id: "8853f6f4-df95-4659-9d3e-35294f0a83a2", name: "Mwaka Isaac", template: APPROVED, who: "Mariam Tusaba (UGX 240,000)" },
  { agent_id: "fb6e6bf7-7147-46c3-b4e1-139fc95a864b", name: "Amolo Diana Sandra", template: APPROVED, who: "Okello Ivan (UGX 160,000) and Kagezi Kato Ali (UGX 180,000)" },
  { agent_id: "1b683203-d500-4c21-a6cb-8f1eb6d4c874", name: "Alinaitwe Brian Martin", template: APPROVED, who: "Katusiime Kenneth (UGX 160,000)" },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    const caller = userRes?.user;
    if (userErr || !caller) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", caller.id);
    const allowed = new Set(["cfo", "super_admin", "manager", "operations", "coo"]);
    if (!(roles ?? []).some((r: { role: string }) => allowed.has(r.role))) {
      return json({ error: "Forbidden" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const confirm = body?.confirm === true;

    const results: Record<string, unknown>[] = [];
    for (const r of RECIPIENTS) {
      const { data: prof } = await admin.from("profiles").select("phone, full_name").eq("id", r.agent_id).maybeSingle();
      const phone = prof?.phone as string | undefined;
      const message = r.template.replace("{who}", r.who);
      if (!phone) {
        results.push({ agent: r.name, sent: false, skipped: "no_phone" });
        continue;
      }
      if (!confirm) {
        results.push({ agent: r.name, phone, would_send: message });
        continue;
      }
      let sent = false;
      let error: string | null = null;
      try {
        sent = await sendSMS(formatPhoneInternational(phone), message, {
          admin,
          source: "send-landlord-payout-resubmit-sms",
          reference_id: r.agent_id,
          recipient_user_id: r.agent_id,
          recipient_name: prof?.full_name ?? r.name,
          idempotencyKey: `landlord-payout-resubmit-2026-09-18-${r.agent_id}`,
        } as any);
      } catch (e) {
        error = (e as Error)?.message ?? String(e);
      }
      results.push({ agent: r.name, sent, error });
    }

    return json({ ok: true, dry_run: !confirm, results });
  } catch (e) {
    console.error("[send-landlord-payout-resubmit-sms] failed:", e);
    return json({ error: (e as Error)?.message ?? "Unexpected error" }, 500);
  }
});
