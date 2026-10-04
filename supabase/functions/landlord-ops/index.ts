import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const authHeader =
      req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const [{ data: roles, error: roleError }, { data: perms, error: permError }] =
      await Promise.all([
        adminClient
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .in("role", ["manager", "coo", "super_admin", "cto"]),
        adminClient
          .from("staff_permissions")
          .select("permitted_dashboard")
          .eq("user_id", user.id)
          .in("permitted_dashboard", ["landlord", "landlord-ops", "landlord_ops"]),
      ]);

    if (roleError) return json({ error: roleError.message }, 500);
    if (permError) return json({ error: permError.message }, 500);
    if (!(roles?.length || perms?.length)) return json({ error: "Insufficient permissions" }, 403);

    const url = new URL(req.url);
    let action = url.searchParams.get("action") ?? "rows";
    let search = url.searchParams.get("search") ?? "";
    let sort = url.searchParams.get("sort") ?? "newest";
    let category = url.searchParams.get("category") ?? "all";
    let pendingFilter = url.searchParams.get("pending_filter") ?? "all";
    let limit = Number(url.searchParams.get("limit") ?? 20);
    let offset = Number(url.searchParams.get("offset") ?? 0);
    let dateFrom = url.searchParams.get("date_from") ?? "";
    let dateTo = url.searchParams.get("date_to") ?? "";

    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body === "object") {
          if (typeof body.action === "string") action = body.action;
          if (typeof body.search === "string") search = body.search;
          if (typeof body.sort === "string") sort = body.sort;
          if (typeof body.category === "string") category = body.category;
          if (typeof body.pending_filter === "string") pendingFilter = body.pending_filter;
          if (typeof body.limit === "number") limit = body.limit;
          if (typeof body.offset === "number") offset = body.offset;
          if (typeof body.date_from === "string") dateFrom = body.date_from;
          if (typeof body.date_to === "string") dateTo = body.date_to;
        }
      } catch (_) {
        /* no body */
      }
    }

    const allowedSorts = new Set(["newest", "oldest", "highest_rent"]);
    if (!allowedSorts.has(sort)) sort = "newest";
    const allowedCategories = new Set([
      "all",
      "verified",
      "pending",
      "rejected",
      "resubmitted",
      "has_tenants",
      "no_tenants",
    ]);
    if (!allowedCategories.has(category)) category = "all";
    const allowedPending = new Set([
      "all",
      "has_address",
      "has_phone",
      "has_smartphone",
      "has_bank",
      "has_momo",
    ]);
    if (!allowedPending.has(pendingFilter)) pendingFilter = "all";
    limit = Math.max(1, Math.min(200, Math.floor(limit) || 20));
    offset = Math.max(0, Math.floor(offset) || 0);

    // Single mapping so the totals action and the rows action can never expose
    // two different shapes for the same numbers.
    const mapTotals = (t: Record<string, unknown> = {}) => ({
      total: Number(t.total ?? 0),
      verified: Number(t.verified ?? 0),
      pending: Number(t.pending ?? 0),
      rejected: Number(t.rejected ?? 0),
      resubmitted: Number(t.resubmitted ?? 0),
      verified_human: Number(t.verified_human ?? 0),
      verified_auto: Number(t.verified_auto ?? 0),
      has_tenants: Number(t.has_tenants ?? 0),
      no_tenants: Number(t.no_tenants ?? 0),
      smartphone: Number(t.smartphone ?? 0),
      occupied_monthly_revenue: Number(t.occupied_monthly_revenue ?? 0),
      empty_monthly_revenue: Number(t.empty_monthly_revenue ?? 0),
    });

    const dateFromIso = dateFrom ? new Date(dateFrom).toISOString() : null;
    const dateToIso = dateTo ? new Date(dateTo).toISOString() : null;

    if (action === "totals") {
      const totalsRes = await adminClient.rpc("get_landlord_ops_totals");
      if (totalsRes.error) return json({ error: totalsRes.error.message }, 500);
      return json({ totals: mapTotals((totalsRes.data && totalsRes.data[0]) || {}) }, 200);
    }

    // Search/date-scoped counts for the landlord verification stats + chips.
    if (action === "scoped_counts") {
      const res = await adminClient.rpc("ops_landlord_status_counts", {
        p_search: search || null,
        p_date_from: dateFromIso,
        p_date_to: dateToIso,
      });
      if (res.error) return json({ error: res.error.message }, 500);
      const r = (res.data && res.data[0]) || {};
      return json({
        counts: {
          all: Number(r.all_landlords ?? 0),
          verified: Number(r.verified ?? 0),
          pending: Number(r.pending ?? 0),
          rejected: Number(r.rejected ?? 0),
          resubmitted: Number(r.resubmitted ?? 0),
          has_tenants: Number(r.has_tenants ?? 0),
          no_tenants: Number(r.no_tenants ?? 0),
          verified_human: Number(r.verified_human ?? 0),
          verified_auto: Number(r.verified_auto ?? 0),
          smartphone: Number(r.smartphone ?? 0),
          occupied_monthly_revenue: Number(r.occupied_monthly_revenue ?? 0),
          empty_monthly_revenue: Number(r.empty_monthly_revenue ?? 0),
        },
      }, 200);
    }

    // Full report payload for the landlord verification PDF export.
    if (action === "report") {
      const res = await adminClient.rpc("ops_landlord_report", {
        p_status: category,
        p_search: search || null,
        p_quick: pendingFilter,
        p_date_from: dateFromIso,
        p_date_to: dateToIso,
        p_limit: 10000,
      });
      if (res.error) return json({ error: res.error.message }, 500);
      const payload = (res.data ?? []) as any[];
      return json({
        rows: payload.map((p) => p.row_data ?? p),
        totalMatched: Number(payload[0]?.total_count ?? payload.length),
      }, 200);
    }

    // Default: rows + totals in parallel so the UI can render KPIs and the list from one call.
    const [totalsRes, rowsRes] = await Promise.all([
      adminClient.rpc("get_landlord_ops_totals"),
      adminClient.rpc("get_landlord_ops_rows", {
        _search: search || null,
        _sort: sort,
        _category: category,
        _pending_filter: pendingFilter,
        _limit: limit,
        _offset: offset,
        _date_from: dateFromIso,
        _date_to: dateToIso,
      }),
    ]);

    if (totalsRes.error) return json({ error: totalsRes.error.message }, 500);
    if (rowsRes.error) return json({ error: rowsRes.error.message }, 500);

    const t = (totalsRes.data && totalsRes.data[0]) || {};
    const totals = mapTotals(t);

    const raw = (rowsRes.data ?? []) as any[];
    const totalMatched = raw.length > 0 ? Number(raw[0].total_matched ?? 0) : 0;
    const rows = raw.map((r) => ({
      id: r.id,
      name: r.name,
      phone: r.phone,
      verified: !!r.verified,
      verification_status: r.verification_status ?? "pending",
      verification_source: r.verification_source ?? "unspecified",
      verification_reason: r.verification_reason ?? null,
      verification_updated_at: r.verification_updated_at ?? null,
      has_smartphone: !!r.has_smartphone,
      mobile_money_name: r.mobile_money_name,
      mobile_money_number: r.mobile_money_number,
      number_of_houses: r.number_of_houses,
      bank_name: r.bank_name,
      account_number: r.account_number,
      monthly_rent: r.monthly_rent == null ? null : Number(r.monthly_rent),
      caretaker_name: r.caretaker_name,
      caretaker_phone: r.caretaker_phone,
      tin: r.tin,
      electricity_meter_number: r.electricity_meter_number,
      water_meter_number: r.water_meter_number,
      village: r.village,
      district: r.district,
      region: r.region,
      property_address: r.property_address,
      tenant_id: r.tenant_id,
      registered_by: r.registered_by,
      managed_by_agent_id: r.managed_by_agent_id,
      house_category: r.house_category,
      number_of_rooms: r.number_of_rooms,
      created_at: r.created_at,
      tenant_count: Number(r.tenant_count ?? 0),
      agent_name: r.agent_name ?? null,
      agent_phone: r.agent_phone ?? null,
      tenant_name: r.primary_tenant_name ?? null,
      tenant_phone_profile: r.primary_tenant_phone ?? null,
    }));

    return json({ rows, totals, totalMatched, limit, offset }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return json({ error: message }, 500);
  }
});

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}