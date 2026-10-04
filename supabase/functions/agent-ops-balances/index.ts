import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "Unauthorized" }, 401);
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const [{ data: roles, error: roleError }, { data: perms, error: permError }] = await Promise.all([
      adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", ["manager", "coo", "super_admin", "cto"]),
      adminClient
        .from("staff_permissions")
        .select("permitted_dashboard")
        .eq("user_id", user.id)
        .in("permitted_dashboard", ["agent", "agent-ops", "agent_ops"]),
    ]);

    if (roleError) return json({ error: roleError.message }, 500);
    if (permError) return json({ error: permError.message }, 500);
    if (!(roles?.length || perms?.length)) {
      return json({ error: "Insufficient permissions" }, 403);
    }

    // Parse query params (support both GET and POST body)
    const url = new URL(req.url);
    let search = url.searchParams.get("search") ?? "";
    let sort = url.searchParams.get("sort") ?? "total";
    let limit = Number(url.searchParams.get("limit") ?? 50);
    let offset = Number(url.searchParams.get("offset") ?? 0);

    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body === "object") {
          if (typeof body.search === "string") search = body.search;
          if (typeof body.sort === "string") sort = body.sort;
          if (typeof body.limit === "number") limit = body.limit;
          if (typeof body.offset === "number") offset = body.offset;
        }
      } catch (_) {
        // no body, ignore
      }
    }

    const allowedSorts = new Set(["total", "withdrawable", "float", "advance", "name"]);
    if (!allowedSorts.has(sort)) sort = "total";
    limit = Math.max(1, Math.min(200, Math.floor(limit) || 50));
    offset = Math.max(0, Math.floor(offset) || 0);

    // Run totals + paginated rows in parallel — both server-computed, no row transfer for totals
    const [totalsRes, rowsRes] = await Promise.all([
      adminClient.rpc("get_agent_ops_totals"),
      adminClient.rpc("get_agent_ops_balances", {
        _search: search || null,
        _sort: sort,
        _limit: limit,
        _offset: offset,
      }),
    ]);

    if (totalsRes.error) return json({ error: totalsRes.error.message }, 500);
    if (rowsRes.error) return json({ error: rowsRes.error.message }, 500);

    const t = (totalsRes.data && totalsRes.data[0]) || {};
    const totals = {
      withdrawable: Number(t.total_withdrawable ?? 0),
      float: Number(t.total_float ?? 0),
      advance: Number(t.total_advance ?? 0),
      total: Number(t.total_held ?? 0),
      count: Number(t.total_count ?? 0),
      withFloat: Number(t.with_float ?? 0),
      withWithdrawable: Number(t.with_withdrawable ?? 0),
      withAdvance: Number(t.with_advance ?? 0),
    };

    const rawRows = (rowsRes.data ?? []) as any[];
    const totalMatched = rawRows.length > 0 ? Number(rawRows[0].total_matched ?? 0) : 0;
    const rows = rawRows.map((r) => ({
      user_id: r.user_id,
      full_name: r.full_name ?? null,
      phone: r.phone ?? null,
      territory: r.territory ?? null,
      withdrawable: Number(r.withdrawable ?? 0),
      float: Number(r.float_balance ?? 0),
      advance: Number(r.advance ?? 0),
      total: Number(r.total ?? 0),
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
