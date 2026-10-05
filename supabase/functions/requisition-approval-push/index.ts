import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { sendPushToSubscription, type PushPayload } from "../_shared/webPushSend.ts";

// Pushes requisition approval prompts hourly until handled (first pushes only
// during 21:00-07:00 Kampala), and pushes each requester notice once. Takes NO
// input: any request body is ignored. Bookkeeping only -- no decision, wallet
// or ledger logic.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface PromptRow {
  id: string;
  requisition_id: string;
  approver_id: string;
  stage: string;
  push_count: number;
  staff_requisitions: {
    stage: string;
    requisition_code: string;
    amount: number;
    approved_amount: number | null;
  } | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const now = new Date();
    const nowIso = now.toISOString();
    const hourAgoIso = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const kampalaHour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Kampala", hour: "2-digit", hour12: false })
        .format(now),
    ) % 24;
    const quietHours = kampalaHour >= 21 || kampalaHour < 7;

    let approverSent = 0;
    let noticeSent = 0;
    let failed = 0;
    let noSubscription = 0;

    async function pushTo(userId: string, payload: PushPayload): Promise<"sent" | "failed" | "none"> {
      const { data: subs } = await supabase.from("push_subscriptions").select("*").eq("user_id", userId);
      if (!subs || subs.length === 0) return "none";
      const results = await Promise.allSettled(subs.map((s) => sendPushToSubscription(s, payload)));
      return results.some((r) => r.status === "fulfilled" && r.value.ok) ? "sent" : "failed";
    }

    // a. Approver prompts, hourly until handled.
    const { data, error } = await supabase
      .from("staff_requisition_prompts")
      .select(
        "id, requisition_id, approver_id, stage, push_count, snooze_until, last_pushed_at, " +
        "staff_requisitions!inner(stage, requisition_code, amount, approved_amount)",
      )
      .neq("state", "resolved");

    if (error) {
      console.error("requisition-approval-push: prompt read failed", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rows = ((data ?? []) as unknown as (PromptRow & {
      snooze_until: string | null;
      last_pushed_at: string | null;
    })[]).filter((p) => {
      if (!p.staff_requisitions || p.staff_requisitions.stage !== p.stage) return false;
      if (p.snooze_until !== null && p.snooze_until > nowIso) return false;
      if (p.last_pushed_at === null) return true;
      if (quietHours) return false; // first pushes only during 21:00-07:00 Kampala
      return p.last_pushed_at <= hourAgoIso;
    });

    for (const prompt of rows) {
      const req = prompt.staff_requisitions!;
      const amount = Number(req.approved_amount ?? req.amount);
      const payload = {
        title: "Requisition awaiting your approval",
        body: `${req.requisition_code} · UGX ${amount.toLocaleString("en-US")}`,
        url: "/",
        tag: `srq-${prompt.requisition_id}`,
        requireInteraction: true,
      } as unknown as PushPayload;

      const outcome = await pushTo(prompt.approver_id, payload);
      if (outcome === "none") { noSubscription += 1; continue; }
      if (outcome === "sent") approverSent += 1; else failed += 1;

      await supabase
        .from("staff_requisition_prompts")
        .update({ last_pushed_at: new Date().toISOString(), push_count: (prompt.push_count ?? 0) + 1 })
        .eq("id", prompt.id);
    }

    // b. Requester notices, pushed once each, any hour.
    const { data: notices, error: nErr } = await supabase
      .from("staff_requisition_notices")
      .select("id, recipient_id, title, body, push_count")
      .is("acknowledged_at", null)
      .is("last_pushed_at", null);

    if (nErr) {
      console.error("requisition-approval-push: notice read failed", nErr);
    }

    for (const n of (notices ?? []) as { id: string; recipient_id: string; title: string; body: string; push_count: number }[]) {
      const payload = {
        title: n.title,
        body: n.body,
        url: "/",
        tag: `srq-note-${n.id}`,
      } as unknown as PushPayload;

      const outcome = await pushTo(n.recipient_id, payload);
      if (outcome === "none") noSubscription += 1;
      else if (outcome === "sent") noticeSent += 1;
      else failed += 1;

      await supabase
        .from("staff_requisition_notices")
        .update({ last_pushed_at: new Date().toISOString(), push_count: (n.push_count ?? 0) + 1 })
        .eq("id", n.id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        approver_sent: approverSent,
        notice_sent: noticeSent,
        failed,
        no_subscription: noSubscription,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Unknown error";
    console.error("requisition-approval-push failed", message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
