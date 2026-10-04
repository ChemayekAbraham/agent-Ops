import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ugx(n: number): string {
  return `UGX ${new Intl.NumberFormat("en-US").format(Math.round(n))}`;
}

interface Recipient {
  user_id: string;
  /** Signed change applied to the withdrawable bucket (0 = unchanged). */
  delta_withdrawable?: number;
  /** Signed change applied to the float bucket (0 = unchanged). */
  delta_float?: number;
  /** Optional reference so repeat runs do not re-send the same SMS. */
  batch?: string;
}

/**
 * One-off, plain-language notice sent to users whose wallet cache was
 * reconciled against the ledger. Users must never see a balance move without
 * being told what moved, by how much, and that the figure was verified.
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({}));
    const recipients: Recipient[] = Array.isArray(body?.recipients) ? body.recipients : [];
    const batch: string = String(body?.batch ?? "wallet-reconcile-2026-08-01");
    const dryRun = body?.dry_run === true;

    if (recipients.length === 0) {
      return new Response(JSON.stringify({ error: "recipients[] required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: unknown[] = [];

    for (const r of recipients) {
      const { data: profile } = await admin
        .from("profiles")
        .select("id, full_name, phone")
        .eq("id", r.user_id)
        .maybeSingle();

      const { data: wallet } = await admin
        .from("wallets")
        .select("withdrawable_balance, float_balance")
        .eq("user_id", r.user_id)
        .maybeSingle();

      const firstName = (profile?.full_name || "there").trim().split(/\s+/)[0];
      const withdrawable = Number(wallet?.withdrawable_balance ?? 0);
      const float = Number(wallet?.float_balance ?? 0);

      const dw = Number(r.delta_withdrawable ?? 0);
      const df = Number(r.delta_float ?? 0);

      // The reconciled (post-correction) figure, so the SMS never quotes a
      // pre-correction cache value alongside the change it describes.
      const total = withdrawable + float + dw + df;

      let msg: string;
      if (dw === 0 && df === 0) {
        msg =
          `Hi ${firstName}, we ran a routine accuracy check on your Welile wallet. ` +
          `Your balance was verified against our transaction records and is unchanged: ` +
          `${ugx(total)}. Nothing was added or removed and no action is needed. - Welile`;
      } else {
        const parts: string[] = [];
        if (dw !== 0) {
          parts.push(
            `${dw > 0 ? "increased" : "reduced"} your withdrawable balance by ${ugx(Math.abs(dw))}`,
          );
        }
        if (df !== 0) {
          parts.push(
            `${df > 0 ? "increased" : "reduced"} your float balance by ${ugx(Math.abs(df))}`,
          );
        }
        msg =
          `Hi ${firstName}, we ran a routine accuracy check on your Welile wallet and ` +
          `${parts.join(" and ")} so it matches your transaction records exactly. ` +
          `Your balance is now ${ugx(total)}. This was a records correction only - ` +
          `no money left or entered your account, and the figure has been verified. ` +
          `Questions? Reply or contact Welile support. - Welile`;
      }

      if (!profile?.phone) {
        results.push({ user_id: r.user_id, sms_sent: false, reason: "no_phone", message: msg });
        continue;
      }

      if (dryRun) {
        results.push({ user_id: r.user_id, phone: profile.phone, dry_run: true, message: msg });
        continue;
      }

      const sent = await sendSMS(profile.phone, msg, {
        admin,
        source: "notify-wallet-reconciliation",
        reference_id: batch,
        recipient_user_id: profile.id,
        recipient_name: profile.full_name ?? null,
        idempotencyKey: `${batch}-${r.user_id}`,
      }).catch((e) => {
        console.error("[notify-wallet-reconciliation] SMS failed:", (e as Error).message);
        return false;
      });

      results.push({ user_id: r.user_id, sms_sent: sent, message: msg });
    }

    return new Response(JSON.stringify({ success: true, batch, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[notify-wallet-reconciliation] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
