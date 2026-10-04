import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
  type?: string;
  // Optional: also notify specific roles beyond managers
  additionalRoles?: string[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { title, body, url, type, additionalRoles }: NotifyPayload = await req.json();

    if (!title || !body) {
      return new Response(
        JSON.stringify({ error: "Missing title or body" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Query all enabled managers (and optional additional roles)
    const rolesToNotify = ['manager', ...(additionalRoles || [])];
    
    const { data: roleUsers, error: roleError } = await supabase
      .from('user_roles')
      .select('user_id')
      .in('role', rolesToNotify)
      .eq('enabled', true);

    if (roleError) {
      console.error('Error fetching manager roles:', roleError);
      return new Response(
        JSON.stringify({ error: "Failed to fetch managers" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!roleUsers || roleUsers.length === 0) {
      return new Response(
        JSON.stringify({ success: true, sent: 0, message: "No managers found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Deduplicate user IDs (a user may have multiple roles)
    const uniqueUserIds = [...new Set(roleUsers.map(r => r.user_id))];

    // Call send-push-notification with all manager user IDs
    const pushResponse = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${supabaseServiceKey}`,
      },
      body: JSON.stringify({
        userIds: uniqueUserIds,
        payload: {
          title,
          body,
          url: url || "/dashboard/manager",
          type: type || "info",
        },
      }),
    });

    const pushResult = await pushResponse.json();

    return new Response(
      JSON.stringify({ success: true, managers: uniqueUserIds.length, pushResult }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error('Error in notify-managers:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
