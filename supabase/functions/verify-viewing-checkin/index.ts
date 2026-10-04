import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Haversine distance in meters
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const PROXIMITY_THRESHOLD_M = 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Verify caller
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const anonClient = createClient(supabaseUrl, anonKey);
    const { data: userData, error: userErr } = await anonClient.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const userId = userData.user.id;

    const body = await req.json();
    const { action, viewing_id, latitude, longitude, pin, rating, feedback } = body;

    if (!viewing_id || typeof viewing_id !== "string") {
      return new Response(JSON.stringify({ error: "viewing_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // Get the viewing
    const { data: viewing, error: viewErr } = await admin
      .from("property_viewings")
      .select("*, house_listings:house_listing_id(latitude, longitude)")
      .eq("id", viewing_id)
      .single();

    if (viewErr || !viewing) {
      return new Response(JSON.stringify({ error: "Viewing not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify user is part of this viewing
    const isAgent = viewing.agent_id === userId;
    const isTenant = viewing.tenant_id === userId;
    if (!isAgent && !isTenant) {
      return new Response(JSON.stringify({ error: "Not authorized for this viewing" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();

    // ── ACTION: GPS CHECK-IN ──
    if (action === "checkin") {
      if (typeof latitude !== "number" || typeof longitude !== "number") {
        return new Response(JSON.stringify({ error: "GPS coordinates required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const houseLat = viewing.house_listings?.latitude;
      const houseLng = viewing.house_listings?.longitude;

      let distance = null;
      let proximityOk = false;

      if (houseLat && houseLng) {
        distance = haversineMeters(latitude, longitude, houseLat, houseLng);
        proximityOk = distance <= PROXIMITY_THRESHOLD_M;
      } else {
        // No GPS on listing — accept check-in but flag no proximity check
        proximityOk = true;
      }

      const updates: Record<string, any> = {};
      if (isAgent) {
        updates.agent_checkin_lat = latitude;
        updates.agent_checkin_lng = longitude;
        updates.agent_checkin_at = now;
        updates.agent_confirmed = true;
        updates.agent_confirmed_at = now;
      } else {
        updates.tenant_checkin_lat = latitude;
        updates.tenant_checkin_lng = longitude;
        updates.tenant_checkin_at = now;
        updates.tenant_confirmed = true;
        updates.tenant_confirmed_at = now;
      }

      // Check if both parties have checked in within proximity
      const agentLat = isAgent ? latitude : viewing.agent_checkin_lat;
      const agentLng = isAgent ? longitude : viewing.agent_checkin_lng;
      const tenantLat = isTenant ? latitude : viewing.tenant_checkin_lat;
      const tenantLng = isTenant ? longitude : viewing.tenant_checkin_lng;

      if (agentLat && agentLng && tenantLat && tenantLng) {
        const partyDistance = haversineMeters(agentLat, agentLng, tenantLat, tenantLng);
        if (partyDistance <= PROXIMITY_THRESHOLD_M) {
          updates.proximity_verified = true;
          updates.proximity_distance_m = partyDistance;
        }
      }

      // Also check proximity to house
      if (distance !== null) {
        updates.proximity_distance_m = distance;
        if (proximityOk) {
          updates.proximity_verified = true;
        }
      }

      await admin.from("property_viewings").update(updates).eq("id", viewing_id);

      return new Response(JSON.stringify({
        success: true,
        proximity_ok: proximityOk,
        distance_m: distance ? Math.round(distance) : null,
        threshold_m: PROXIMITY_THRESHOLD_M,
        role: isAgent ? "agent" : "tenant",
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTION: PIN VERIFICATION ──
    if (action === "verify_pin") {
      if (!pin || typeof pin !== "string" || pin.length !== 4) {
        return new Response(JSON.stringify({ error: "4-digit PIN required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (!isAgent) {
        return new Response(JSON.stringify({ error: "Only agent can verify PIN" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (viewing.viewing_pin !== pin) {
        return new Response(JSON.stringify({ error: "Incorrect PIN", pin_match: false }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      await admin.from("property_viewings").update({
        pin_verified: true,
        pin_verified_at: now,
      }).eq("id", viewing_id);

      return new Response(JSON.stringify({ success: true, pin_match: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── ACTION: RATE VIEWING ──
    if (action === "rate") {
      if (typeof rating !== "number" || rating < 1 || rating > 5) {
        return new Response(JSON.stringify({ error: "Rating 1-5 required" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const updates: Record<string, any> = {};
      if (isAgent) {
        updates.agent_rating = rating;
        updates.agent_feedback = feedback || null;
        updates.agent_rated_at = now;
      } else {
        updates.tenant_rating = rating;
        updates.tenant_feedback = feedback || null;
        updates.tenant_rated_at = now;
      }

      // If both parties have rated, auto-advance to "viewed" if still scheduled
      const otherRated = isAgent ? viewing.tenant_rating : viewing.agent_rating;
      if (otherRated && viewing.status === "scheduled") {
        updates.status = "viewed";
      }

      await admin.from("property_viewings").update(updates).eq("id", viewing_id);

      return new Response(JSON.stringify({ success: true, role: isAgent ? "agent" : "tenant" }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: "Unknown action. Use: checkin, verify_pin, rate" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("[verify-viewing-checkin] Error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
