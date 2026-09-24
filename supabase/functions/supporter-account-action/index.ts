import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller identity
    const authHeader = req.headers.get("authorization") || "";
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authError } = await anonClient.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json();
    const { action, portfolio_id, amount, reason } = body;

    if (!portfolio_id || !action) {
      return new Response(JSON.stringify({ error: "Missing portfolio_id or action" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch portfolio
    const { data: portfolio, error: pErr } = await admin
      .from("investor_portfolios")
      .select("*, profiles!investor_portfolios_investor_id_fkey(full_name, email, phone)")
      .eq("id", portfolio_id)
      .single();

    if (pErr || !portfolio) {
      return new Response(JSON.stringify({ error: "Portfolio not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user owns this portfolio
    if (portfolio.investor_id !== user.id && portfolio.agent_id !== user.id) {
      return new Response(JSON.stringify({ error: "Access denied" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const profileData = portfolio.profiles as any;
    const supporterEmail = profileData?.email || user.email;
    const supporterName = profileData?.full_name || "Supporter";
    const accountName = portfolio.account_name || portfolio.portfolio_code;

    let result: any = {};
    let emailSubject = "";
    let emailBody = "";

    switch (action) {
      case "renew": {
        // Renew for another 12 months
        const now = new Date();
        const newMaturity = new Date(now);
        newMaturity.setMonth(newMaturity.getMonth() + 12);

        const { error: uErr } = await admin
          .from("investor_portfolios")
          .update({
            duration_months: 12,
            maturity_date: newMaturity.toISOString(),
            total_roi_earned: 0,
            status: "active",
          })
          .eq("id", portfolio_id);

        if (uErr) throw uErr;

        // Log audit
        await admin.from("audit_logs").insert({
          user_id: user.id,
          action_type: "portfolio_renewal",
          table_name: "investor_portfolios",
          record_id: portfolio_id,
          metadata: {
            reason: reason || "Self-service renewal",
            new_maturity: newMaturity.toISOString(),
            previous_earned: portfolio.total_roi_earned,
          },
        });

        result = { success: true, new_maturity: newMaturity.toISOString() };
        emailSubject = `🔄 Account Renewed: ${accountName}`;
        emailBody = `Hi ${supporterName},\n\nYour support account "${accountName}" has been renewed for another 12 months.\n\n• New Maturity: ${newMaturity.toLocaleDateString("en-UG", { year: "numeric", month: "long", day: "numeric" })}\n• ROI Rate: ${portfolio.roi_percentage}%\n• Capital: UGX ${Number(portfolio.investment_amount).toLocaleString()}\n\nYour earned rewards counter has been reset for this new cycle. Thank you for your continued support!\n\n— Welile Technologies`;
        break;
      }

      case "withdraw_capital": {
        const withdrawAmount = Number(amount);
        if (!withdrawAmount || withdrawAmount <= 0) {
          return new Response(JSON.stringify({ error: "Invalid withdrawal amount" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        if (withdrawAmount > Number(portfolio.investment_amount)) {
          return new Response(JSON.stringify({ error: "Amount exceeds account capital" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Create withdrawal request with 90-day notice
        const processDate = new Date();
        processDate.setDate(processDate.getDate() + 90);

        const { error: wErr } = await admin
          .from("investment_withdrawal_requests")
          .insert({
            user_id: user.id,
            amount: withdrawAmount,
            reason: reason || `Capital withdrawal from ${accountName}`,
            rewards_paused: true,
            earliest_process_date: processDate.toISOString(),
          });

        if (wErr) throw wErr;

        // Log audit
        await admin.from("audit_logs").insert({
          user_id: user.id,
          action_type: "capital_withdrawal_request",
          table_name: "investment_withdrawal_requests",
          record_id: portfolio_id,
          metadata: {
            amount: withdrawAmount,
            portfolio_id,
            reason: reason || "Self-service withdrawal",
            process_date: processDate.toISOString(),
          },
        });

        result = { success: true, process_date: processDate.toISOString(), amount: withdrawAmount };
        emailSubject = `📋 Capital Withdrawal Requested: ${accountName}`;
        emailBody = `Hi ${supporterName},\n\nYour capital withdrawal request has been submitted.\n\n• Account: ${accountName}\n• Amount: UGX ${withdrawAmount.toLocaleString()}\n• 90-Day Notice Period: Your payout will be processed on or after ${processDate.toLocaleDateString("en-UG", { year: "numeric", month: "long", day: "numeric" })}\n\n⚠️ Monthly rewards are now PAUSED on this withdrawn portion.\n\nThe 90-day window allows our agents to collect repayments from tenants so your full amount is available.\n\n— Welile Technologies`;
        break;
      }

      case "toggle_roi_mode": {
        const currentMode = portfolio.roi_mode;
        const newMode = currentMode === "compound" || currentMode === "monthly_compounding"
          ? "simple"
          : "compound";

        const { error: tErr } = await admin
          .from("investor_portfolios")
          .update({ roi_mode: newMode })
          .eq("id", portfolio_id);

        if (tErr) throw tErr;

        // Log audit
        await admin.from("audit_logs").insert({
          user_id: user.id,
          action_type: "roi_mode_change",
          table_name: "investor_portfolios",
          record_id: portfolio_id,
          metadata: {
            previous_mode: currentMode,
            new_mode: newMode,
            reason: reason || "Self-service toggle",
          },
        });

        const modeLabel = newMode === "compound" ? "Compounding" : "Simple";
        result = { success: true, new_mode: newMode };
        emailSubject = `⚙️ Account Mode Changed: ${accountName}`;
        emailBody = `Hi ${supporterName},\n\nYour support account "${accountName}" has been switched to ${modeLabel} mode.\n\n${newMode === "compound"
          ? "• Compounding: Your monthly rewards are automatically reinvested, growing your capital each month."
          : "• Simple: Your monthly rewards are paid out to your wallet each cycle without reinvestment."
        }\n\n• ROI Rate: ${portfolio.roi_percentage}%\n• Current Capital: UGX ${Number(portfolio.investment_amount).toLocaleString()}\n\nThis change takes effect from your next payout cycle.\n\n— Welile Technologies`;
        break;
      }

      case "set_auto_support": {
        // Single switch keeps both fields in step: auto_reinvest drives the
        // monthly Returns run; roi_mode is what every screen and report shows.
        const enabled = body.enabled === true;
        const newMode = enabled ? "monthly_compounding" : "monthly_payout";
        const previous = { auto_reinvest: portfolio.auto_reinvest, roi_mode: portfolio.roi_mode };

        const { data: updated, error: sErr } = await admin
          .from("investor_portfolios")
          .update({ auto_reinvest: enabled, roi_mode: newMode })
          .eq("id", portfolio_id)
          .select("auto_reinvest, roi_mode")
          .single();
        if (sErr) throw sErr;
        if (!updated || updated.auto_reinvest !== enabled || updated.roi_mode !== newMode) {
          throw new Error("Auto-Support setting was not saved. Please try again.");
        }

        await admin.from("audit_logs").insert({
          user_id: user.id,
          action_type: "auto_support_change",
          table_name: "investor_portfolios",
          record_id: portfolio_id,
          metadata: {
            previous,
            new_auto_reinvest: enabled,
            new_mode: newMode,
            reason: reason || "Self-service Auto-Support toggle",
          },
        });

        result = { success: true, auto_reinvest: enabled, roi_mode: newMode };
        emailSubject = `⚙️ Auto-Support ${enabled ? "turned ON" : "turned OFF"}: ${accountName}`;
        emailBody = `Hi ${supporterName},\n\nAuto-Support on your support account "${accountName}" is now ${enabled ? "ON" : "OFF"}.\n\n${enabled
          ? "• Compounding: your monthly Returns are added to your capital each month, so your capital grows."
          : "• Monthly payout: your monthly Returns are paid to your wallet each cycle."
        }\n\n• Returns rate: ${portfolio.roi_percentage}%\n• Current capital: UGX ${Number(portfolio.investment_amount).toLocaleString()}\n\nThis change takes effect from your next Returns cycle.\n\n— Welile Technologies`;
        break;
      }

      default:
        return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }

    // Send email notification via enqueue if available, otherwise log
    if (supporterEmail) {
      try {
        await admin.rpc("enqueue_email" as any, {
          p_queue_name: "transactional_emails",
          p_message: JSON.stringify({
            to: supporterEmail,
            subject: emailSubject,
            text: emailBody,
            template_name: "supporter_account_action",
          }),
        });
      } catch (emailErr) {
        // Fallback: log the email attempt
        console.log("[supporter-account-action] Email enqueue failed, logging:", emailErr);
        await admin.from("audit_logs").insert({
          user_id: user.id,
          action_type: "email_notification_failed",
          table_name: "investor_portfolios",
          record_id: portfolio_id,
          metadata: {
            email: supporterEmail,
            subject: emailSubject,
            error: String(emailErr),
          },
        });
      }
    }


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceRoleKey}` },
      body: JSON.stringify({ title: "💼 Supporter Action", body: "Activity: supporter account action", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[supporter-account-action] Error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
