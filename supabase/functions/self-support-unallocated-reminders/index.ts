// Reminds self-support partners who have not yet chosen tenants or houses for
// their whole contract, 14 days after Partner Ops countersigned the agreement.
//
// ONE REMINDER PER AGREEMENT, EVER
// claim_due_self_support_reminders() marks each due agreement as reminded and
// returns it once, so repeated runs (or an early manual call) cannot send twice.
// Nothing is converted automatically: the money stays with the partner.
//
// Channels: SMS + email to the partner, and an email copy to the partnerships
// mailbox for Partner Ops. (In-app notifications are blocked for this type.)
//
// Read-only over money: no wallet, ledger or portfolio state is changed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { suppressSignupPrompt } from "../_shared/smsSignupPrompt.ts";

suppressSignupPrompt();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const PARTNERSHIP_EMAIL = "partnership@welile.com";
const DASHBOARD_URL = "https://welileapp.com/dashboard/funder";

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-US")}`;

interface Due {
  agreement_id: string;
  partner_id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  contract_amount: number;
  remaining: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const summary = { due: 0, sms_sent: 0, emails_sent: 0, errors: [] as string[] };

  try {
    const { data, error } = await admin.rpc("claim_due_self_support_reminders", { p_limit: 200 });
    if (error) throw error;
    const due = (data || []) as Due[];
    summary.due = due.length;

    for (const d of due) {
      const name = d.full_name || "Supporter";
      const left = Number(d.remaining) || 0;

      if (d.phone) {
        try {
          const ok = await sendSMS(
            d.phone,
            `Dear ${name}, ${ugx(left)} of your Welile partnership is waiting for you to choose tenants or houses to support. Open your dashboard to choose.`,
            {
              admin,
              source: "self_support_unallocated_reminder",
              recipient_user_id: d.partner_id,
              recipient_name: name,
              reference_id: d.agreement_id,
              idempotencyKey: `self-support-unallocated-${d.agreement_id}`,
            },
          );
          if (ok) summary.sms_sent++;
          else summary.errors.push(`${d.agreement_id}: sms returned false`);
        } catch (e) {
          summary.errors.push(`${d.agreement_id}: sms ${e instanceof Error ? e.message : "failed"}`);
        }
      }

      const templateData = {
        partner_name: name,
        remaining: left,
        contract_amount: Number(d.contract_amount) || 0,
        currency: "UGX",
        dashboard_url: DASHBOARD_URL,
      };
      const recipients = [d.email, PARTNERSHIP_EMAIL].filter((x): x is string => !!x);
      for (const to of recipients) {
        try {
          const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
            body: {
              templateName: "self-support-unallocated",
              recipientEmail: to,
              idempotencyKey: `self-support-unallocated-${d.agreement_id}-${to}`,
              templateData,
            },
          });
          if (mailErr) throw mailErr;
          summary.emails_sent++;
        } catch (e) {
          summary.errors.push(`${d.agreement_id}: email ${to} ${e instanceof Error ? e.message : "failed"}`);
        }
      }
    }

    return new Response(JSON.stringify({ success: true, ...summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[self-support-unallocated-reminders] failed", e instanceof Error ? e.message : e);
    return new Response(
      JSON.stringify({ success: false, error: e instanceof Error ? e.message : "failed", ...summary }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
