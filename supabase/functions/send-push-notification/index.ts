import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import { sendPushToSubscription, type PushPayload } from "../_shared/webPushSend.ts";

// VAPID encryption/JWT signing moved to ../_shared/webPushSend.ts (Stage 6),
// so the Stage 6 channel router and this broadcast entrypoint share exactly
// one implementation instead of two that can drift. This file's own contract
// (request shape, response shape, gone-subscription cleanup) is unchanged.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface RequestBody {
  userIds?: string[]; // Specific user IDs to notify
  all?: boolean; // Send to all users
  payload: PushPayload;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const { userIds, all, payload }: RequestBody = await req.json();

    if (!payload || !payload.title) {
      return new Response(
        JSON.stringify({ error: "Missing payload or title" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Fetch push subscriptions
    let query = supabase.from('push_subscriptions').select('*');

    if (all) {
      // Get all subscriptions
    } else if (userIds && userIds.length > 0) {
      query = query.in('user_id', userIds);
    } else {
      return new Response(
        JSON.stringify({ error: "Must specify userIds or all=true" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { data: subscriptions, error } = await query;

    if (error) {
      console.error('Error fetching subscriptions:', error);
      return new Response(
        JSON.stringify({ error: "Failed to fetch subscriptions" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!subscriptions || subscriptions.length === 0) {
      return new Response(
        JSON.stringify({ success: true, sent: 0, message: "No push subscriptions found" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Send notifications in parallel
    const results = await Promise.allSettled(
      subscriptions.map(sub => sendPushToSubscription(sub, payload))
    );

    const successful = results.filter(
      r => r.status === 'fulfilled' && r.value.ok,
    ).length;
    const failed = results.length - successful;

    // Clean up ONLY permanently-gone endpoints (404/410). Transient failures
    // keep their subscription so a single bad send never wipes a live device.
    const failedSubs = subscriptions.filter((_, i) => {
      const r = results[i];
      return r.status === 'fulfilled' && r.value.gone;
    });

    if (failedSubs.length > 0) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .in('endpoint', failedSubs.map(s => s.endpoint));
    }

    return new Response(
      JSON.stringify({
        success: true,
        sent: successful,
        failed,
        total: subscriptions.length
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error('Error in send-push-notification:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
