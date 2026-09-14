import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const YOOLA_DELIVERY_URL = "https://yoolasms.com/api/v1/delivery_report";

type SweepRow = {
  id: string;
  created_at: string;
  status: string;
  provider_message_id: string | null;
  provider_response: unknown;
};

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function extractYoolaMessageId(providerMessageId: string | null, providerResponse: unknown): string | null {
  if (providerMessageId && !providerMessageId.startsWith("YOOLA-")) return providerMessageId;
  const response = providerResponse as any;
  const directResponse = response?.provider_response ?? response;
  const winningAttempt = Array.isArray(response?.attempts)
    ? response.attempts.find((attempt: any) => attempt?.provider === "yoola" && attempt?.ok)
    : null;
  const yoolaResponse = winningAttempt?.response ?? directResponse;
  const recipient = Array.isArray(yoolaResponse?.per_recipient) ? yoolaResponse.per_recipient[0] : null;
  return firstString(yoolaResponse?.message_id, yoolaResponse?.messageId, yoolaResponse?.id, recipient?.message_id, recipient?.messageId);
}

function mapYoolaStatus(rawStatus: unknown): { status: "delivered" | "failed" | "pending"; error: string | null } {
  const normalized = String(rawStatus ?? "").trim().toLowerCase();
  if (["delivered", "success"].includes(normalized)) return { status: "delivered", error: null };
  if (["failed", "rejected", "undelivered", "expired", "blocked"].includes(normalized)) {
    return { status: "failed", error: `Yoola delivery report: ${normalized || "failed"}` };
  }
  return {
    status: "pending",
    error: normalized ? `Yoola delivery report still shows ${normalized}; handset delivery not confirmed yet` : null,
  };
}

async function callerHasOpsAccess(authHeader: string): Promise<boolean> {
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return false;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: roles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .in("role", ["cfo", "cto", "manager", "super_admin", "operations"]);
  return Boolean(roles?.length);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    // Scheduled runs (pg_cron) carry no user session — they identify themselves
    // with mode:"cron" and get a counts-only response. Manual runs from the ops
    // UI still require an authorized staff user.
    const isCronRun = String((body as any)?.mode ?? "") === "cron";
    const authHeader = req.headers.get("Authorization") || "";
    if (!isCronRun && !(await callerHasOpsAccess(authHeader))) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const apiKey = Deno.env.get("YOOLA_SMS_API_KEY")?.trim();
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "Yoola is not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const limit = Math.max(1, Math.min(Number((body as any)?.limit ?? 100) || 100, 250));
    const sinceHours = Math.max(1, Math.min(Number((body as any)?.since_hours ?? 72) || 72, 24 * 14));
    const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString();

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: rows, error: rowsError } = await admin
      .from("sms_delivery_log")
      .select("id, created_at, status, provider_message_id, provider_response")
      .eq("provider", "yoola")
      .in("status", ["sent", "accepted", "pending", "queued"])
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (rowsError) throw rowsError;

    const results: Array<Record<string, unknown>> = [];
    for (const row of (rows ?? []) as SweepRow[]) {
      const messageId = extractYoolaMessageId(row.provider_message_id, row.provider_response);
      if (!messageId) {
        results.push({ id: row.id, checked: false, reason: "missing_yoola_message_id" });
        continue;
      }

      const response = await fetch(YOOLA_DELIVERY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ api_key: apiKey, message_id: messageId }),
      });
      const raw = await response.text();
      let report: any = null;
      try { report = JSON.parse(raw); } catch { report = { raw: raw.slice(0, 500) }; }

      if (!response.ok || String(report?.status ?? "").toLowerCase() !== "success") {
        await admin
          .from("sms_delivery_log")
          .update({
            provider_message_id: messageId,
            provider_response: {
              ...((row.provider_response && typeof row.provider_response === "object") ? row.provider_response as Record<string, unknown> : { send_response: row.provider_response ?? null }),
              delivery_report_error: report,
              delivery_report_checked_at: new Date().toISOString(),
            },
            error: `Yoola delivery report lookup failed: HTTP ${response.status}`,
          })
          .eq("id", row.id);
        results.push({ id: row.id, message_id: messageId, checked: true, status: "lookup_failed" });
        continue;
      }

      const mapped = mapYoolaStatus(report?.sms_status ?? report?.delivery_status ?? report?.status_text);
      const mergedResponse = {
        ...((row.provider_response && typeof row.provider_response === "object") ? row.provider_response as Record<string, unknown> : { send_response: row.provider_response ?? null }),
        delivery_report: report,
        delivery_report_checked_at: new Date().toISOString(),
      };

      await admin
        .from("sms_delivery_log")
        .update({
          status: mapped.status,
          provider_message_id: messageId,
          provider_response: mergedResponse,
          error: mapped.error,
        })
        .eq("id", row.id);

      results.push({ id: row.id, message_id: messageId, checked: true, status: mapped.status, yoola_status: report?.sms_status ?? null });
    }

    return new Response(JSON.stringify(
      isCronRun
        ? { ok: true, checked: results.length }
        : { ok: true, checked: results.length, results },
    ), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: any) {
    console.error("[sms-yoola-delivery-sweep] error:", error);
    return new Response(JSON.stringify({ error: error?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});