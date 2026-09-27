// Notifies the applying agent that their smartphone order was rejected, with
// the written reason. In-app notification + SMS. Only sends for orders that are
// actually rejected; SMS is idempotent per order. Failures never undo the
// rejection, which has already happened by the time this runs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = auth.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

    const { sale_id } = await req.json().catch(() => ({ sale_id: null }));
    if (!sale_id || typeof sale_id !== "string") return json({ error: "Missing sale_id" }, 400);

    const { data: sale, error: saleErr } = await admin
      .from("merchandise_sales")
      .select("id, customer_id, item_name, brand, model_type, order_status, rejection_reason")
      .eq("id", sale_id)
      .maybeSingle();
    if (saleErr) throw saleErr;
    if (!sale) return json({ error: "Order not found" }, 404);
    if (sale.order_status !== "rejected") return json({ error: "Order is not rejected" }, 409);
    if (!sale.customer_id) return json({ success: true, skipped: "no_customer" });

    const { data: agent } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .eq("id", sale.customer_id)
      .maybeSingle();

    const device = [sale.brand, sale.model_type].filter(Boolean).join(" ") || sale.item_name || "smartphone";
    const reason = String(sale.rejection_reason ?? "").trim() || "No reason given";
    const firstName = (agent?.full_name || "Agent").split(" ")[0];
    const results: Record<string, unknown> = {};

    try {
      const { error } = await admin.from("notifications").insert({
        user_id: sale.customer_id,
        title: "Smartphone application rejected",
        message: `Your application for the ${device} was not approved. Reason: ${reason}. No money was taken from your wallet.`,
        type: "merchandise",
        metadata: { kind: "smartphone_order_rejected", sale_id, reason },
      });
      if (error) throw error;
      results.in_app = true;
    } catch (e) {
      console.error("[notify-smartphone-order-rejected] in-app failed:", (e as Error).message);
      results.in_app = false;
    }

    if (agent?.phone) {
      const msg = `Hi ${firstName}, your Welile application for the ${device} was not approved. Reason: ${reason}. No money was taken from your wallet. — Welile`;
      results.sms = await sendSMS(agent.phone, msg, {
        admin,
        source: "notify-smartphone-order-rejected",
        reference_id: sale_id,
        recipient_user_id: agent.id,
        recipient_name: agent.full_name ?? null,
        idempotencyKey: `smartphone-rejected-${sale_id}`,
      }).catch((e) => {
        console.error("[notify-smartphone-order-rejected] SMS failed:", (e as Error).message);
        return false;
      });
    } else {
      results.sms = false;
      results.sms_skipped = "no_phone";
    }

    return json({ success: true, ...results });
  } catch (e) {
    console.error("[notify-smartphone-order-rejected]", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
