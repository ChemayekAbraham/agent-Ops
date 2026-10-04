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
  if (await attemptYoolaPrimary(phone, message, { source: "vacancy-alerts" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.warn("[vacancy-alerts] Missing AT credentials, skipping SMS");
    return false;
  }

  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";

  const formattedPhone = formatPhoneInternational(phone);

  try {
    const params: Record<string, string> = {
      username,
      to: formattedPhone,
      message,
    };
    const body = new URLSearchParams(params);

    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
      },
      body: body.toString(),
    });

    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    const statusCode = recipients[0]?.statusCode;
    return statusCode === 100 || statusCode === 101;
  } catch (err) {
    console.error("[vacancy-alerts] SMS error:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Find houses empty for 14+ days that haven't been alerted recently
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86400000).toISOString();

    const { data: emptyHouses, error } = await supabaseAdmin
      .from("house_listings")
      .select("id, title, address, region, monthly_rent, daily_rate, agent_id, landlord_id, created_at, landlords(name, phone)")
      .eq("status", "available")
      .is("tenant_id", null)
      .lt("created_at", fourteenDaysAgo)
      .limit(50);

    if (error) throw error;

    if (!emptyHouses?.length) {
      return new Response(JSON.stringify({ message: "No vacant houses needing alerts", sent: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get agent profiles for phone numbers
    const agentIds = [...new Set(emptyHouses.map((h: any) => h.agent_id).filter(Boolean))];
    let agentMap = new Map<string, { full_name: string; phone: string }>();
    if (agentIds.length) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, phone")
        .in("id", agentIds);
      if (profiles) {
        agentMap = new Map(profiles.map((p: any) => [p.id, p]));
      }
    }

    let smsSent = 0;
    const results: any[] = [];

    for (const house of emptyHouses as any[]) {
      const daysEmpty = Math.floor((Date.now() - new Date(house.created_at).getTime()) / 86400000);
      const agent = agentMap.get(house.agent_id);
      const landlord = house.landlords;

      // Send SMS to agent
      if (agent?.phone) {
        const agentMsg = `🏚️ VACANCY ALERT: "${house.title}" in ${house.region} has been empty for ${daysEmpty} days. Monthly rent: UGX ${house.monthly_rent.toLocaleString()}. Consider reducing rent or promoting this listing to attract tenants. - Welile`;
        const sent = await sendSMS(agent.phone, agentMsg);
        if (sent) smsSent++;
        results.push({ type: "agent", phone: agent.phone, sent, house: house.title });
      }

      // Send SMS to landlord
      if (landlord?.phone) {
        const landlordMsg = `Dear ${landlord.name}, your property "${house.title}" in ${house.region} has been vacant for ${daysEmpty} days. Your agent is working to find a tenant. Contact Welile for assistance. - Welile`;
        const sent = await sendSMS(landlord.phone, landlordMsg);
        if (sent) smsSent++;
        results.push({ type: "landlord", phone: landlord.phone, sent, house: house.title });
      }

      // Create in-app notification for agent
      if (agent) {
        await supabaseAdmin.from("notifications").insert({
          user_id: house.agent_id,
          title: `🏚️ Vacancy Alert: ${house.title}`,
          message: `This property has been empty for ${daysEmpty} days. Consider reducing rent (currently UGX ${house.monthly_rent.toLocaleString()}/mo) to attract tenants.`,
          type: "vacancy_alert",
          read: false,
        }).catch(() => {}); // Ignore if notifications table doesn't exist
      }
    }

    return new Response(JSON.stringify({
      message: `Vacancy alerts processed`,
      housesChecked: emptyHouses.length,
      smsSent,
      results,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[vacancy-alerts] Error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
