// Notifies the applying agent once the CFO has released a phone order and the
// down payment has been paid into the supplier's wallet. Sends an in-app
// notification, an SMS and (when an email is on file) a transactional email.
// Every channel is individually fault tolerant — a failure never blocks the
// release, which has already happened by the time this runs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatUGX(n: number): string {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

function fmtDate(d: Date): string {
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "long", year: "numeric", timeZone: "Africa/Kampala",
  });
}

function fmtDateTime(d: Date): string {
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
    timeZone: "Africa/Kampala",
  });
}

function isRealEmail(email: string | null | undefined): boolean {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) && !/@example\./i.test(email);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { sale_id } = await req.json().catch(() => ({ sale_id: null }));
    if (!sale_id || typeof sale_id !== "string") {
      return new Response(JSON.stringify({ error: "Missing sale_id" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: sale, error: saleErr } = await admin
      .from("merchandise_sales")
      .select(
        "id, customer_id, supplier_id, item_name, brand, model_type, total_amount, disbursed_amount, unit_price, access_daily_amount, tracking_reference, cfo_disbursed_at",
      )
      .eq("id", sale_id)
      .maybeSingle();

    if (saleErr) throw saleErr;
    if (!sale) {
      return new Response(JSON.stringify({ error: "Order not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (!sale.customer_id) {
      return new Response(JSON.stringify({ success: true, skipped: "no_customer" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const [{ data: agent }, { data: supplier }, { data: plan }] = await Promise.all([
      admin.from("profiles").select("id, full_name, phone, email").eq("id", sale.customer_id).maybeSingle(),
      sale.supplier_id
        ? admin.from("profiles").select("id, full_name, phone, email").eq("id", sale.supplier_id).maybeSingle()
        : Promise.resolve({ data: null } as any),
      admin
        .from("merchandise_recovery_plans")
        .select("daily_deduction_amount, starts_on, outstanding_balance")
        .eq("sale_id", sale_id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);

    const amount = Number(sale.disbursed_amount ?? sale.total_amount ?? sale.unit_price ?? 0);
    const daily = Number(plan?.daily_deduction_amount ?? sale.access_daily_amount ?? 0);
    const startsOn = plan?.starts_on ? fmtDate(new Date(`${plan.starts_on}T00:00:00Z`)) : "";
    const device = [sale.brand, sale.model_type].filter(Boolean).join(" ") || sale.item_name || "device";
    const isIphone = /iphone/i.test(String(sale.brand ?? ""));
    const supplierName = supplier?.full_name || "the assigned supplier";
    const supplierPhone = supplier?.phone || "";
    const supplierEmail = isRealEmail(supplier?.email) ? supplier!.email! : "";
    const firstName = (agent?.full_name || "Agent").split(" ")[0];
    const disbursedAt = fmtDateTime(new Date(sale.cfo_disbursed_at ?? new Date().toISOString()));

    const supplierContactLine = [
      supplier?.full_name ? `Supplier: ${supplier.full_name}` : null,
      supplierPhone ? `Tel ${supplierPhone}` : null,
      supplierEmail ? supplierEmail : null,
    ].filter(Boolean).join(" · ");

    const results: Record<string, unknown> = {};

    // 1. In-app notification (money event — always recorded)
    try {
      const parts = [
        `UGX ${formatUGX(amount)} ${isIphone ? "down payment " : ""}has been paid to ${supplierName}'s wallet for your ${device}. Your order is now in procedure.`,
        daily > 0
          ? `You repay Welile UGX ${formatUGX(daily)} daily${startsOn ? ` from ${startsOn}` : ""}, from your wallet or commission.`
          : null,
        isIphone ? "The weekly payment to Mo Banja is made directly to Mo Banja, outside Welile." : null,
        supplierContactLine ? `Track your device with ${supplierContactLine}.` : null,
      ].filter(Boolean);

      const { error: notifErr } = await admin.from("notifications").insert({
        user_id: sale.customer_id,
        title: "Down payment sent to supplier",
        message: parts.join(" "),
        type: "merchandise",
        metadata: {
          kind: "smartphone_order_disbursed",
          sale_id,
          amount,
          daily_amount: daily,
          repayment_starts_on: plan?.starts_on ?? null,
          supplier_id: sale.supplier_id ?? null,
          supplier_name: supplier?.full_name ?? null,
          supplier_phone: supplierPhone || null,
          supplier_email: supplierEmail || null,
        },
      });
      if (notifErr) throw notifErr;
      results.in_app = true;
    } catch (e) {
      console.error("[notify-smartphone-order-disbursed] in-app failed:", (e as Error).message);
      results.in_app = false;
    }

    // 2. SMS
    if (agent?.phone) {
      const smsParts = [
        `Hi ${firstName}, UGX ${formatUGX(amount)} ${isIphone ? "down payment " : ""}for your ${device} has been paid to ${supplierName}'s wallet. Your order is in procedure.`,
        daily > 0 ? `You repay Welile UGX ${formatUGX(daily)} daily${startsOn ? ` from ${startsOn}` : ""}.` : null,
        isIphone ? "Pay Mo Banja weekly directly." : null,
        supplierContactLine ? `Track: ${supplierContactLine}` : null,
        "— Welile",
      ].filter(Boolean);

      results.sms = await sendSMS(agent.phone, smsParts.join(" "), {
        admin,
        source: "notify-smartphone-order-disbursed",
        reference_id: sale_id,
        recipient_user_id: agent.id,
        recipient_name: agent.full_name ?? null,
        idempotencyKey: `smartphone-disbursed-${sale_id}`,
      }).catch((e) => {
        console.error("[notify-smartphone-order-disbursed] SMS failed:", (e as Error).message);
        return false;
      });
    } else {
      results.sms = false;
      results.sms_skipped = "no_phone";
    }

    // 3. Email
    if (isRealEmail(agent?.email)) {
      try {
        const { error: emailErr } = await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: "smartphone-order-disbursed",
            recipientEmail: agent!.email,
            idempotencyKey: `smartphone-disbursed-${sale_id}`,
            templateData: {
              recipient_name: agent?.full_name || firstName,
              amount,
              currency: "UGX",
              item_label: sale.item_name || "Welile Smartphone",
              brand: sale.brand || "",
              model: sale.model_type || "",
              daily_amount: daily > 0 ? daily : null,
              repayment_starts_on: startsOn,
              supplier_name: supplier?.full_name || "",
              supplier_phone: supplierPhone,
              supplier_email: supplierEmail,
              order_reference: sale.id,
              tracking_reference: sale.tracking_reference || "",
              disbursed_at: disbursedAt,
            },
          },
        });
        if (emailErr) throw emailErr;
        results.email = true;
      } catch (e) {
        console.error("[notify-smartphone-order-disbursed] email failed:", (e as Error).message);
        results.email = false;
      }
    } else {
      results.email = false;
      results.email_skipped = "no_email";
    }

    return new Response(JSON.stringify({ success: true, ...results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-smartphone-order-disbursed] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
