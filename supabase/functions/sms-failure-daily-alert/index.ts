import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Run the detection routine (raises/refreshes today's alert when threshold crossed)
    const { data: result, error } = await supabase.rpc("detect_sms_failure_alerts");
    if (error) {
      console.error("[sms-failure-daily-alert] RPC error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const r = (result || {}) as Record<string, any>;
    console.log("[sms-failure-daily-alert] detection result:", JSON.stringify(r));

    let emailsSent = 0;

    // Optional email when triggered + email enabled + recipients configured
    if (r.triggered && r.email_enabled && Array.isArray(r.email_recipients) && r.email_recipients.length > 0) {
      const alertId = r.alert_id as string | undefined;

      // Avoid duplicate emails for the same alert row
      let alreadyEmailed = false;
      if (alertId) {
        const { data: alertRow } = await supabase
          .from("sms_failure_alerts")
          .select("email_sent")
          .eq("id", alertId)
          .maybeSingle();
        alreadyEmailed = !!alertRow?.email_sent;
      }

      if (!alreadyEmailed) {
        const templateData = {
          failedCount: r.failed,
          totalCount: r.total,
          failureRatePct: r.failure_rate_pct,
          severity: r.severity,
          windowStart: r.window_start,
          windowEnd: r.window_end,
          topFailedReferences: r.top_failed_references || [],
        };

        for (const recipient of r.email_recipients as string[]) {
          try {
            const { error: emailErr } = await supabase.functions.invoke("send-transactional-email", {
              body: {
                templateName: "sms-failure-alert",
                recipientEmail: recipient,
                idempotencyKey: `sms-failure-${alertId || r.run_id}-${recipient}`,
                templateData,
              },
            });
            if (emailErr) {
              console.error(`[sms-failure-daily-alert] email error for ${recipient}:`, emailErr);
            } else {
              emailsSent += 1;
            }
          } catch (e) {
            console.error(`[sms-failure-daily-alert] email exception for ${recipient}:`, e);
          }
        }

        if (alertId && emailsSent > 0) {
          await supabase
            .from("sms_failure_alerts")
            .update({ email_sent: true })
            .eq("id", alertId);
        }
      }
    }

    return new Response(JSON.stringify({ success: true, ...r, emails_sent: emailsSent }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[sms-failure-daily-alert] error:", err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});