import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function formatPhoneInternational(phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "send-funder-statement" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY") || Deno.env.get("AT_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME") || Deno.env.get("AT_USERNAME");
  if (!apiKey || !username) {
    console.error("[send-funder-statement] Missing AT credentials");
    return false;
  }

  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);

  try {
    const params: Record<string, string> = { username, to: formattedPhone, message };
    const body = new URLSearchParams(params);

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const rawText = await res.text();
    console.log(`[send-funder-statement] AT response for ${formattedPhone}:`, rawText);

    let data: any;
    try { data = JSON.parse(rawText); } catch { return false; }
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 101 || r.statusCode === 100);
  } catch (err) {
    console.error("[send-funder-statement] Error:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const { funder_id, agent_id } = await req.json();

    if (!funder_id) {
      return new Response(JSON.stringify({ error: "funder_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get funder profile
    const { data: funder } = await supabase
      .from("profiles")
      .select("id, full_name, phone")
      .eq("id", funder_id)
      .single();

    if (!funder || !funder.phone) {
      return new Response(JSON.stringify({ error: "Funder not found or no phone" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get active portfolios
    const { data: portfolios } = await supabase
      .from("investor_portfolios")
      .select("id, portfolio_code, account_name, investment_amount, total_roi_earned, status, created_at")
      .eq("investor_id", funder_id)
      .in("status", ["active", "matured"])
      .order("created_at", { ascending: false });

    const totalInvested = (portfolios || []).reduce((s: number, p: any) => s + (p.investment_amount || 0), 0);
    const totalROI = (portfolios || []).reduce((s, p) => s + (p.total_roi_earned || 0), 0);
    const activeCount = (portfolios || []).filter(p => p.status === "active").length;

    // Get wallet balance
    const { data: wallet } = await supabase
      .from("wallets")
      .select("balance")
      .eq("user_id", funder_id)
      .maybeSingle();

    const walletBalance = wallet?.balance || 0;

    // Get recent ROI payments
    const { data: recentROI } = await supabase
      .from("supporter_roi_payments")
      .select("amount, paid_at")
      .eq("supporter_id", funder_id)
      .order("paid_at", { ascending: false })
      .limit(3);

    // Build SMS message (keep under 160 chars per segment where possible)
    const lines = [
      `WELILE Investment Statement`,
      `Dear ${(funder.full_name || "Partner").split(" ")[0]},`,
      ``,
      `Wallet: UGX ${walletBalance.toLocaleString()}`,
      `Total Invested: UGX ${totalInvested.toLocaleString()}`,
      `Returns Earned: UGX ${totalROI.toLocaleString()}`,
      `Active Accounts: ${activeCount}`,
    ];

    if (recentROI && recentROI.length > 0) {
      lines.push(``);
      lines.push(`Last Return: UGX ${recentROI[0].amount.toLocaleString()}`);
    }

    lines.push(``);
    lines.push(`Your money is safe & working.`);
    lines.push(`Questions? Call your Welile agent.`);

    const message = lines.join("\n");
    const sent = await sendSMS(funder.phone, message);

    // Log the statement send
    if (agent_id) {
      await supabase.from("audit_logs").insert({
        user_id: agent_id,
        action: "funder_statement_sent",
        details: `SMS statement sent to ${funder.full_name} (${funder.phone}). Invested: UGX ${totalInvested.toLocaleString()}, ROI: UGX ${totalROI.toLocaleString()}`,
      });
    }

    return new Response(
      JSON.stringify({
        success: sent,
        message_preview: message,
        stats: { totalInvested, totalROI, activeCount, walletBalance },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[send-funder-statement] Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
