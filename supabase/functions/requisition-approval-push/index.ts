import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { sendPushToSubscription, type PushPayload } from "../_shared/webPushSend.ts";

// Re-sends the web push for a requisition approval prompt each time a deferral
// expires while the item is still open. Takes NO input: any request body is
// ignored. Prompt bookkeeping only -- no decision, wallet or ledger logic.

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

    const nowIso = new Date().toISOString();

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
      if (!p.last_pushed_at) return true;
      return (
        p.snooze_until !== null &&
        p.snooze_until <= nowIso &&
        p.last_pushed_at < p.snooze_until
      );
    });

    let sent = 0;
    let failed = 0;
    let noSubscription = 0;

    for (const prompt of rows) {
      const req = prompt.staff_requisitions!;
      const amount = Number(req.approved_amount ?? req.amount);

      const { data: subs } = await supabase
        .from("push_subscriptions")
        .select("*")
        .eq("user_id", prompt.approver_id);

      if (!subs || subs.length === 0) {
        noSubscription += 1;
        continue;
      }

      const payload = {
        title: "Requisition awaiting your approval",
        body: `${req.requisition_code} · UGX ${amount.toLocaleString("en-US")}`,
        url: "/",
        tag: `srq-${prompt.requisition_id}`,
        requireInteraction: true,
      } as unknown as PushPayload;

      const results = await Promise.allSettled(
        subs.map((s) => sendPushToSubscription(s, payload)),
      );
      const ok = results.some((r) => r.status === "fulfilled" && r.value.ok);
      if (ok) sent += 1; else failed += 1;

      await supabase
        .from("staff_requisition_prompts")
        .update({ last_pushed_at: new Date().toISOString(), push_count: (prompt.push_count ?? 0) + 1 })
        .eq("id", prompt.id);
    }

    return new Response(
      JSON.stringify({ success: true, sent, failed, no_subscription: noSubscription, considered: rows.length }),
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
