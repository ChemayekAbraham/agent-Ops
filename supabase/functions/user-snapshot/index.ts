import { createClient } from "npm:@supabase/supabase-js@2";

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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Use anon client with user's auth header to verify token via getClaims
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await userClient.auth.getClaims(token);

    if (claimsError || !claimsData?.claims?.sub) {
      console.error("[user-snapshot] Token verification failed:", claimsError?.message);
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = claimsData.claims.sub as string;

    // Service-role client for data queries (bypasses RLS)
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // ── Tier selection ────────────────────────────────────────────
    // critical → wallet + profile + roles only (fastest first paint)
    // extended → everything else (background fill)
    // all      → both (legacy, default)
    // Tier can arrive via querystring (legacy direct fetch) OR via the JSON
    // body — the supabase-js `functions.invoke()` SDK URL-encodes the entire
    // function name, so `invoke('user-snapshot?tier=critical')` 404s. Clients
    // now pass `{ tier }` in the body; the querystring path is kept for
    // backwards compatibility with any direct curl-style callers.
    const url = new URL(req.url);
    let tierRaw = url.searchParams.get("tier");
    if (!tierRaw && (req.method === "POST" || req.method === "PUT")) {
      try {
        const body = await req.clone().json();
        if (body && typeof body.tier === "string") tierRaw = body.tier;
      } catch {
        // body wasn't JSON — ignore and fall through to default
      }
    }
    const tier = (tierRaw || "all").toLowerCase() as
      | "critical"
      | "extended"
      | "all";
    const wantCritical = tier === "critical" || tier === "all";
    const wantExtended = tier === "extended" || tier === "all";

    // Fetch user roles first to determine what data to fetch
    const { data: roles } = await supabase
      .from("user_roles")
      .select("role, enabled")
      .eq("user_id", userId);

    const activeRoles = (roles || [])
      .filter((r) => r.enabled)
      .map((r) => r.role);

    // ── Batch ALL queries in parallel ──────────────────────────────
    // deno-lint-ignore no-explicit-any
    const queries: Record<string, any> = {};

    // ── CRITICAL tier: profile + wallet only ─────────────────────
    if (wantCritical) {
      queries.profile = supabase
      .from("profiles")
      .select("id, full_name, phone, email, city, country, avatar_url, mobile_money_number, mobile_money_provider, monthly_rent, verified, national_id, rent_discount_active, is_frozen, country_code, agent_type")
      .eq("id", userId)
      .maybeSingle();

      queries.wallet = supabase
      .from("wallets")
      .select("id, user_id, balance, updated_at")
      .eq("user_id", userId)
      .maybeSingle();
    }

    // ── EXTENDED tier: everything else ───────────────────────────
    if (wantExtended) {
    queries.notifications = supabase
      .from("notifications")
      .select("id, title, message, type, is_read, created_at, metadata")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);

    queries.referrals = supabase
      .from("referrals")
      .select("id, referred_id, bonus_amount, credited, credited_at, created_at, first_transaction_bonus_amount, first_transaction_bonus_credited")
      .eq("referrer_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);

    queries.referralCount = supabase
      .from("referrals")
      .select("*", { count: "exact", head: true })
      .eq("referrer_id", userId);

    // ── Agent-specific data ───────────────────────────────────────
    if (activeRoles.includes("agent")) {
      queries.subAgents = supabase
        .from("agent_subagents")
        .select("id, sub_agent_id, created_at, source")
        .eq("parent_agent_id", userId);

      queries.pendingSubAgentInvites = supabase
        .from("supporter_invites")
        .select("id, full_name, phone, status, created_at")
        .eq("created_by", userId)
        .eq("role", "agent")
        .eq("status", "pending");

      queries.userInvites = supabase
        .from("supporter_invites")
        .select("id, full_name, phone, role, status, created_at")
        .eq("created_by", userId)
        .in("role", ["tenant", "landlord"]);

      queries.linkSignups = supabase
        .from("profiles")
        .select("id, full_name, phone, created_at")
        .eq("referrer_id", userId)
        .limit(50);

      queries.earningsSummary = supabase
        .from("agent_earnings")
        .select("earning_type, amount")
        .eq("agent_id", userId);

      queries.agentEarnings = supabase
        .from("agent_earnings")
        .select("id, amount, earning_type, description, created_at, rent_request_id, source_user_id")
        .eq("agent_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);
    }

    // ── Tenant-specific data ──────────────────────────────────────
    if (activeRoles.includes("tenant")) {
      queries.landlords = supabase
        .from("landlords")
        .select("id, name, phone, property_address, monthly_rent, verified")
        .eq("tenant_id", userId);

      queries.rentRequests = supabase
        .from("rent_requests")
        .select(
          "id, rent_amount, total_repayment, daily_repayment, duration_days, status, schedule_status, created_at, number_of_payments, amount_repaid, access_fee, request_fee"
        )
        .eq("tenant_id", userId)
        .order("created_at", { ascending: false })
        .limit(10);

      queries.repayments = supabase
        .from("repayments")
        .select("id, amount, rent_request_id, created_at")
        .eq("tenant_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);
    }

    // ── Supporter-specific data ───────────────────────────────────
    if (activeRoles.includes("supporter")) {
      queries.supporterReferrals = supabase
        .from("supporter_referrals")
        .select("id, referred_id, bonus_amount, bonus_credited, first_investment_at, created_at")
        .eq("referrer_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);

      // investment_accounts table removed — skip
    }

    // ── Recent wallet transactions (general_ledger) ─────────────
    queries.recentTransactions = supabase
      .from("general_ledger")
      .select("id, user_id, category, amount, description, direction, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);
    } // end wantExtended

    // ── Execute all queries in parallel ───────────────────────────
    const results: Record<string, any> = {};
    const entries = Object.entries(queries);
    const settled = await Promise.allSettled(entries.map(([, q]) => q));

    for (let i = 0; i < entries.length; i++) {
      const [key] = entries[i];
      const result = settled[i];
      if (result.status === "fulfilled") {
        const { data, count, error } = result.value;
        if (error) {
          console.error(`Query ${key} error:`, error.message);
          results[key] = null;
        } else {
          results[key] = count !== undefined && count !== null ? { data, count } : data;
        }
      } else {
        console.error(`Query ${key} rejected:`, result.reason);
        results[key] = null;
      }
    }

    // Enrich referrals with profile data (name, phone, city) — extended only
    let enrichedReferrals = results.referrals || [];
    if (wantExtended && enrichedReferrals.length > 0) {
      const referredIds = enrichedReferrals.map((r: any) => r.referred_id);
      const { data: referredProfiles } = await supabase
        .from("profiles")
        .select("id, full_name, phone, city")
        .in("id", referredIds);

      const profileMap: Record<string, any> = {};
      if (referredProfiles) {
        for (const p of referredProfiles) {
          profileMap[p.id] = p;
        }
      }

      enrichedReferrals = enrichedReferrals.map((r: any) => {
        const profile = profileMap[r.referred_id];
        const referralStatus: 'completed' | 'incomplete' = profile
          ? 'completed'
          : 'incomplete';
        return {
          ...r,
          referred_name:
            profile?.full_name ||
            (r.referred_id
              ? `Onboarding incomplete · …${String(r.referred_id).slice(-6)}`
              : 'Onboarding incomplete'),
          referred_phone: profile?.phone || null,
          referred_city: profile?.city || null,
          referral_status: referralStatus,
        };
      });
    }

    // Build snapshot — fields outside the requested tier are omitted so the
    // client merger never overwrites fresher extended data with `null`/`[]`.
    const snapshot: Record<string, unknown> = {
      userId,
      roles: activeRoles,
      fetchedAt: new Date().toISOString(),
      version: 2, // Schema version for client-side compatibility
      tier,
    };

    if (wantCritical) {
      snapshot.profile = results.profile || null;
      snapshot.wallet = results.wallet || null;
    }

    if (wantExtended) {
      snapshot.notifications = results.notifications || [];
      snapshot.recentTransactions = results.recentTransactions || [];
      snapshot.referrals = enrichedReferrals;
      snapshot.referralCount =
        results.referralCount?.count ?? (enrichedReferrals.length || 0);
      snapshot.subAgents = results.subAgents || [];
      snapshot.pendingSubAgentInvites = results.pendingSubAgentInvites || [];
      snapshot.userInvites = results.userInvites || [];
      snapshot.linkSignups = results.linkSignups || [];
      snapshot.earningsSummary = results.earningsSummary || [];
      snapshot.agentEarnings = results.agentEarnings || [];
      snapshot.landlords = results.landlords || [];
      snapshot.rentRequests = results.rentRequests || [];
      snapshot.repayments = results.repayments || [];
      snapshot.supporterReferrals = results.supporterReferrals || [];
      snapshot.investmentAccount = null; // table removed
    }

    return new Response(JSON.stringify(snapshot), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("user-snapshot error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
