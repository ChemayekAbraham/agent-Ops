import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

    const { listing_id, reason } = await req.json();
    if (!listing_id || !reason) {
      return new Response(JSON.stringify({ error: "Missing listing_id/reason" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: listing } = await admin
      .from("house_listings")
      .select("id, title, agent_id")
      .eq("id", listing_id)
      .maybeSingle();

    if (!listing?.agent_id) {
      return new Response(JSON.stringify({ success: true, push_sent: 0, reason: "no_listing_agent" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const title = listing.title || "your listing";

    // Does the agent have any push subscription at all? If not, the rejection
    // alert can only reach them via the in-app notification (already written by
    // the reject_house_listing RPC). We surface `has_subscription: false` so the
    // UI can nudge the agent to enable notifications on their device.
    const { count: subCount } = await admin
      .from("push_subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", listing.agent_id);

    const hasSubscription = (subCount ?? 0) > 0;

    // Web push only — no SMS. Delegate the actual VAPID encryption/delivery to
    // the shared send-push-notification function.
    let pushSent = 0;
    if (hasSubscription) {
      const { data: pushRes, error: pushErr } = await admin.functions.invoke(
        "send-push-notification",
        {
          body: {
            userIds: [listing.agent_id],
            payload: {
              title: "Listing rejected",
              body: `Your listing "${title}" was rejected. Reason: ${String(reason).trim()}. Please review and re-list.`,
              type: "warning",
              url: "/dashboard/agent",
            },
          },
        },
      );
      if (pushErr) {
        console.error("[notify-listing-rejected] push invoke error", pushErr);
      } else {
        pushSent = Number((pushRes as any)?.sent ?? 0);
      }
    }

    // ─── Parent-agent web push (skip merchant/cash-out parents) ───
    let parentPushSent = 0;
    let parentAgentId: string | null = null;
    try {
      const { data: link } = await admin
        .from("agent_subagents")
        .select("parent_agent_id")
        .eq("sub_agent_id", listing.agent_id)
        .eq("status", "verified")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      parentAgentId = link?.parent_agent_id ?? null;

      if (parentAgentId && parentAgentId !== listing.agent_id) {
        const { data: merchant } = await admin
          .from("cashout_agents")
          .select("id")
          .eq("agent_id", parentAgentId)
          .eq("is_active", true)
          .maybeSingle();

        if (!merchant) {
          const [{ data: subProfile }, { count: rejCount }] = await Promise.all([
            admin.from("profiles").select("full_name").eq("id", listing.agent_id).maybeSingle(),
            admin
              .from("agent_listing_rejections")
              .select("id", { count: "exact", head: true })
              .eq("agent_id", listing.agent_id),
          ]);

          const subName = subProfile?.full_name || "your sub-agent";
          const count = rejCount ?? 0;
          const charged = count > 0 && count % 3 === 0;
          const body = charged
            ? `Sub-agent ${subName}'s house "${title}" was rejected. Reason: ${String(reason).trim()}. UGX 6,000 was deducted (3 of their listings rejected).`
            : `Sub-agent ${subName}'s house "${title}" was rejected. Reason: ${String(reason).trim()}. You'll be deducted UGX 6,000 if a 3rd of their listings is rejected (${count}/3).`;

          const { data: parentPushRes, error: parentPushErr } = await admin.functions.invoke(
            "send-push-notification",
            {
              body: {
                userIds: [parentAgentId],
                payload: {
                  title: "⚠️ Sub-agent listing rejected",
                  body,
                  type: "warning",
                  url: "/dashboard/agent",
                },
              },
            },
          );
          if (parentPushErr) {
            console.error("[notify-listing-rejected] parent push invoke error", parentPushErr);
          } else {
            parentPushSent = Number((parentPushRes as any)?.sent ?? 0);
          }
        }
      }
    } catch (parentErr) {
      console.error("[notify-listing-rejected] parent push flow failed", parentErr);
    }

    return new Response(
      JSON.stringify({
        success: true,
        push_sent: pushSent,
        has_subscription: hasSubscription,
        parent_agent_id: parentAgentId,
        parent_push_sent: parentPushSent,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[notify-listing-rejected] Error:", err);
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});