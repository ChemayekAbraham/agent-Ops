// Collection error intake.
//
// WHY THIS EXISTS WHEN AN RPC ALREADY DID THE JOB
//
// `log_agent_collection_error` is a Postgres RPC called over the same
// connection that just failed. The three failures it exists to record are
// "Failed to fetch", a stalled network, and an expired session — and in all
// three the logging call goes out over the same broken path and is lost too.
// The log filled with anomalies (written server-side by a cron) and almost
// nothing from the engine, which is exactly the wrong way round.
//
// This function fixes the three holes the RPC cannot:
//
//   1. IT WRITES WITH THE SERVICE ROLE. An expired or revoked session still
//      gets its error recorded. The RPC returns NULL when auth.uid() is null,
//      so a session failure was previously unloggable BY DEFINITION.
//   2. IT ACCEPTS A BEACON. `navigator.sendBeacon` cannot set an Authorization
//      header, so the token comes in the body instead. A beacon survives the
//      tab closing and the app crashing, which an awaited fetch does not.
//   3. IT RECORDS HOW THE REPORT ARRIVED. `reported_via` makes a gap in one
//      path visible instead of silent — a run of rows that only ever arrive by
//      beacon means pages are dying mid-collection, which is itself the finding.
//
// ANONYMOUS REPORTS ARE ACCEPTED ON PURPOSE. The single most valuable report is
// the one from a device whose session just died, and that device cannot prove
// who it is. Such a row is stored with a null agent_id, is rate-limited per IP,
// and is marked so nobody mistakes it for an attributed one. Refusing it would
// throw away the evidence we most need.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PHASES = new Set([
  "allocate", "allocate_stalled", "allocate_rejected",
  "offline_submit", "confirm", "sync", "other",
]);
const SEVERITIES = new Set(["critical", "error", "warning"]);

/** Per-identity ceiling. A retry loop on a broken phone must not become the log. */
const MAX_PER_HOUR_IDENTIFIED = 60;
/** Anonymous reports are cheaper to forge, so they get a tighter cap. */
const MAX_PER_HOUR_ANONYMOUS = 20;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const uuid = (v: unknown): string | null =>
  typeof v === "string" && UUID_RE.test(v) ? v : null;
const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // A logger must never be the thing that breaks. Every failure below returns
  // 200 with `logged: false` rather than an error the caller has to handle —
  // the caller is already handling a failure of its own.
  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ logged: false, reason: "unparseable body" }), { headers: jsonHeaders });
    }

    // Token from the header when invoked normally, from the body when beaconed.
    const headerToken = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const token = headerToken || str(body.access_token, 4000) || "";

    let agentId: string | null = null;
    if (token) {
      try {
        const { data } = await admin.auth.getUser(token);
        agentId = data?.user?.id ?? null;
      } catch {
        agentId = null; // An expired token is the case this exists to serve.
      }
    }

    const ip =
      req.headers.get("cf-connecting-ip") ??
      (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ??
      null;

    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cap = agentId ? MAX_PER_HOUR_IDENTIFIED : MAX_PER_HOUR_ANONYMOUS;
    const { count } = await admin
      .from("agent_collection_errors")
      .select("id", { count: "exact", head: true })
      .gte("occurred_at", since)
      .eq(agentId ? "agent_id" : "ip_address", agentId ?? (ip || "unknown"));

    if ((count ?? 0) >= cap) {
      return new Response(JSON.stringify({ logged: false, reason: "rate limited" }), { headers: jsonHeaders });
    }

    const phaseRaw = str(body.phase, 40) ?? "other";
    const sevRaw = str(body.severity, 20) ?? "error";
    const viaRaw = str(body.reported_via, 20) ?? "edge";

    const context = body.context && typeof body.context === "object" ? body.context : null;
    const contextSized =
      context && JSON.stringify(context).length <= 8000 ? context : null;

    const { data: inserted, error } = await admin
      .from("agent_collection_errors")
      .insert({
        agent_id: agentId,
        tenant_id: uuid(body.tenant_id),
        rent_request_id: uuid(body.rent_request_id),
        amount: numOrNull(body.amount),
        phase: PHASES.has(phaseRaw) ? phaseRaw : "other",
        error_code: str(body.error_code, 80),
        message: str(body.message, 2000) ?? "unspecified error",
        client_ref: uuid(body.client_ref),
        severity: SEVERITIES.has(sevRaw) ? sevRaw : "error",
        context: contextSized,
        // The device tells us what it could see at the moment it broke. Most
        // collection failures are network ones, and none of this survives in a
        // stack trace.
        user_agent: str(body.user_agent, 400) ?? str(req.headers.get("user-agent"), 400),
        app_version: str(body.app_version, 80),
        page_url: str(body.page_url, 400),
        network: str(body.network, 120),
        ip_address: ip ? ip.slice(0, 64) : null,
        reported_via: viaRaw === "beacon" ? "beacon" : "edge",
      })
      .select("id")
      .single();

    if (error) {
      console.error("[log-collection-error] insert failed", error.message);
      return new Response(JSON.stringify({ logged: false, reason: error.message }), { headers: jsonHeaders });
    }

    return new Response(
      JSON.stringify({ logged: true, id: inserted?.id ?? null, attributed: !!agentId }),
      { headers: jsonHeaders },
    );
  } catch (e) {
    console.error("[log-collection-error]", (e as Error)?.message ?? e);
    return new Response(JSON.stringify({ logged: false }), { headers: jsonHeaders });
  }
});
