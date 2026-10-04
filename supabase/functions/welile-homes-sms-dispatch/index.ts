import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString("en-US")}`;
const monthLabel = (d: string | null) => {
  if (!d) return "this month";
  try {
    return new Date(d).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  } catch {
    return "this month";
  }
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let sinceMinutes = 120;
    try {
      const body = await req.json();
      if (body && Number.isFinite(Number(body.since_minutes))) {
        sinceMinutes = Math.min(Math.max(Number(body.since_minutes), 5), 1440);
      }
    } catch {
      // no body → default window
    }
    const sinceIso = new Date(Date.now() - sinceMinutes * 60_000).toISOString();

    let collectionSent = 0;
    let payoutSent = 0;

    // ── Tenant collection receipts ─────────────────────────────────────────
    const { data: collectEvents } = await supabase
      .from("system_events")
      .select("id, user_id, related_entity_id, metadata, created_at")
      .eq("event_type", "payment_made")
      .eq("related_entity_type", "welile_homes_subscription")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(500);

    for (const ev of collectEvents || []) {
      const meta = (ev.metadata || {}) as Record<string, unknown>;
      if (meta.action !== "collection") continue;
      const amount = Number(meta.amount) || 0;
      if (amount <= 0) continue;

      const { data: sub } = await supabase
        .from("welile_homes_subscriptions")
        .select("tenant_id, landlord_name, outstanding_balance, monthly_rent")
        .eq("id", ev.related_entity_id)
        .maybeSingle();
      if (!sub?.tenant_id) continue;

      const { data: tenant } = await supabase
        .from("profiles")
        .select("full_name, phone")
        .eq("id", sub.tenant_id)
        .maybeSingle();
      if (!tenant?.phone) continue;

      const outstanding = Number(sub.outstanding_balance) || 0;
      const landlord = sub.landlord_name ? ` to ${sub.landlord_name}` : "";
      const msg =
        `WELILE HOMES receipt: ${ugx(amount)} received towards your rent${landlord}. ` +
        (outstanding > 0 ? `Balance remaining: ${ugx(outstanding)}. ` : `Your rent is fully cleared. `) +
        `Thank you.`;

      const ok = await sendSMS(tenant.phone, msg, {
        admin: supabase,
        source: "welile_homes_collection",
        reference_id: String(ev.related_entity_id),
        recipient_user_id: sub.tenant_id,
        recipient_name: tenant.full_name,
        idempotencyKey: `welile_collect_sms:${ev.id}`,
      });
      if (ok) collectionSent++;
    }

    // ── Landlord payout receipts ────────────────────────────────────────────
    const { data: payoutEvents } = await supabase
      .from("system_events")
      .select("id, related_entity_id, metadata, created_at")
      .eq("event_type", "rent_disbursed")
      .eq("related_entity_type", "welile_homes_monthly_dues")
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: true })
      .limit(500);

    for (const ev of payoutEvents || []) {
      const meta = (ev.metadata || {}) as Record<string, unknown>;
      if (meta.action !== "landlord_payout") continue;
      const amount = Number(meta.amount) || 0;
      if (amount <= 0) continue;
      const via = String(meta.via || "");

      const { data: due } = await supabase
        .from("welile_homes_monthly_dues")
        .select("period_month, subscription_id")
        .eq("id", ev.related_entity_id)
        .maybeSingle();
      if (!due?.subscription_id) continue;

      const { data: sub } = await supabase
        .from("welile_homes_subscriptions")
        .select("landlord_id, landlord_name, landlord_phone, agent_id")
        .eq("id", due.subscription_id)
        .maybeSingle();
      if (!sub) continue;

      // Resolve landlord phone: wallet payout → their profile; float payout → stored number.
      let phone: string | null = sub.landlord_phone || null;
      let recipientUserId: string | null = sub.landlord_id || null;
      if (via === "wallet" && sub.landlord_id) {
        const { data: ll } = await supabase
          .from("profiles")
          .select("phone")
          .eq("id", sub.landlord_id)
          .maybeSingle();
        if (ll?.phone) phone = ll.phone;
      }
      if (!phone) continue;

      const month = monthLabel(due.period_month);
      let msg: string;
      if (via === "wallet") {
        msg =
          `WELILE HOMES: ${ugx(amount)} rent for ${month} has been paid into your Welile wallet. ` +
          `Log in to withdraw. Thank you.`;
      } else {
        let agentName = "your Welile agent";
        if (sub.agent_id) {
          const { data: ag } = await supabase
            .from("profiles")
            .select("full_name")
            .eq("id", sub.agent_id)
            .maybeSingle();
          if (ag?.full_name) agentName = ag.full_name;
        }
        msg =
          `WELILE HOMES: ${ugx(amount)} rent for ${month} is ready. ` +
          `${agentName} will hand it to you. Thank you.`;
      }

      const ok = await sendSMS(phone, msg, {
        admin: supabase,
        source: "welile_homes_landlord_payout",
        reference_id: String(ev.related_entity_id),
        recipient_user_id: recipientUserId,
        recipient_name: sub.landlord_name,
        idempotencyKey: `welile_payout_sms:${ev.id}`,
      });
      if (ok) payoutSent++;
    }

    return new Response(
      JSON.stringify({ success: true, collection_receipts_sent: collectionSent, payout_receipts_sent: payoutSent, window_minutes: sinceMinutes }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    console.error("[welile-homes-sms-dispatch] error:", err);
    return new Response(JSON.stringify({ success: false, error: (err as Error)?.message || String(err) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
