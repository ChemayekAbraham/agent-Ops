import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  agentName?: string;
  amount?: number;
  reason?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { agentName, amount, reason }: RequestBody = await req.json().catch(() => ({}));

    // Resolve all enabled CFO users
    const { data: roleUsers, error: roleError } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "cfo")
      .eq("enabled", true);

    if (roleError) {
      console.error("[notify-cfo-float-request] role fetch error:", roleError);
      return new Response(JSON.stringify({ error: "Failed to fetch CFO users" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const uniqueUserIds = [...new Set((roleUsers ?? []).map((r) => r.user_id))];
    if (uniqueUserIds.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0, message: "No CFO users" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const amountLabel =
      typeof amount === "number" && Number.isFinite(amount)
        ? `UGX ${Math.round(amount).toLocaleString()}`
        : "float";
    const who = agentName?.trim() || "A merchant agent";
    const body = `${who} requested ${amountLabel}${reason ? ` — ${reason}` : ""}. Review and fund from Merchant Float.`;

    const pushResponse = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        userIds: uniqueUserIds,
        payload: {
          title: "🏦 Merchant Float Request",
          body,
          url: "/dashboard/cfo",
          type: "float_request",
        },
      }),
    });

    const pushResult = await pushResponse.json().catch(() => ({}));

    return new Response(
      JSON.stringify({ success: true, cfoUsers: uniqueUserIds.length, pushResult }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error: unknown) {
    console.error("[notify-cfo-float-request] error:", error);
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});