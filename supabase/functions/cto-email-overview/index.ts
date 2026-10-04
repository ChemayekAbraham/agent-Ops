import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["cto", "super_admin", "manager"]);
    if (!roles || roles.length === 0) {
      return json({ error: "Insufficient permissions" }, 403);
    }

    const url = new URL(req.url);
    const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") ?? 30)));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Backend search mode: when the CTO types a query in the Recent Emails
    // table, search hits the database directly across ALL time (not just the
    // current range / capped set). recentOnly skips the heavy KPI computation
    // and returns only matching rows so each keystroke stays cheap.
    const search = (url.searchParams.get("search") ?? "").trim().replace(/[,()*]/g, " ").trim();
    const recentOnly = url.searchParams.get("recentOnly") === "1";
    if (recentOnly) {
      let q = adminClient
        .from("email_send_log")
        .select("id, message_id, template_name, recipient_email, status, error_message, created_at, metadata")
        .order("created_at", { ascending: false })
        .limit(2000);
      if (search) {
        const like = `%${search}%`;
        q = q.or(
          `recipient_email.ilike.${like},template_name.ilike.${like},error_message.ilike.${like}`,
        );
      } else {
        // No query → fall back to the recent set within the selected range.
        q = q.gte("created_at", since);
      }
      const { data: matches, error: mErr } = await q;
      if (mErr) return json({ error: mErr.message }, 500);
      return json({ recent: matches ?? [] }, 200);
    }

    // Pull recent log rows in one go (capped) — used for KPIs, time-series, and table
    const { data: rows, error: rowsErr } = await adminClient
      .from("email_send_log")
      .select("id, message_id, template_name, recipient_email, status, error_message, created_at, metadata")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(5000);
    if (rowsErr) return json({ error: rowsErr.message }, 500);

    const all = rows ?? [];

    // KPIs
    const totalSent = all.filter((r) => r.status === "sent").length;
    const totalFailed = all.filter((r) => r.status === "failed" || r.status === "dlq").length;
    const totalBounced = all.filter((r) => r.status === "bounced").length;
    const totalPending = all.filter((r) => r.status === "pending").length;
    const totalSuppressed = all.filter((r) => r.status === "suppressed").length;
    const total = all.length;
    const deliveryRate = total > 0 ? Math.round((totalSent / total) * 1000) / 10 : 0;
    const uniqueRecipients = new Set(all.map((r) => r.recipient_email)).size;

    // Daily series
    const seriesMap = new Map<string, { day: string; sent: number; failed: number; pending: number; total: number }>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const k = d.toISOString().slice(0, 10);
      seriesMap.set(k, { day: k, sent: 0, failed: 0, pending: 0, total: 0 });
    }
    for (const r of all) {
      const k = (r.created_at as string).slice(0, 10);
      const bucket = seriesMap.get(k);
      if (!bucket) continue;
      bucket.total++;
      if (r.status === "sent") bucket.sent++;
      else if (r.status === "failed" || r.status === "dlq" || r.status === "bounced") bucket.failed++;
      else if (r.status === "pending") bucket.pending++;
    }
    const series = Array.from(seriesMap.values());

    // Template summary table
    const tplMap = new Map<string, { template: string; total: number; sent: number; failed: number; pending: number; lastSentAt: string | null }>();
    for (const r of all) {
      const key = r.template_name || "unknown";
      const cur = tplMap.get(key) || { template: key, total: 0, sent: 0, failed: 0, pending: 0, lastSentAt: null };
      cur.total++;
      if (r.status === "sent") cur.sent++;
      else if (r.status === "failed" || r.status === "dlq" || r.status === "bounced") cur.failed++;
      else if (r.status === "pending") cur.pending++;
      const ts = r.created_at as string;
      if (!cur.lastSentAt || ts > cur.lastSentAt) cur.lastSentAt = ts;
      tplMap.set(key, cur);
    }
    const templateSummary = Array.from(tplMap.values()).sort((a, b) => b.total - a.total);

    // Full recent set (already capped at 5000 by the query above) so the
    // CTO Emails table can search across every recent email, not just 100.
    const recent = all;

    // Error breakdown — categorize failed/bounced/dlq emails
    const failedRows = all.filter((r) => r.status === "failed" || r.status === "dlq" || r.status === "bounced");
    const categoryMap = new Map<string, number>();
    const messageMap = new Map<string, { message: string; count: number; category: string; lastSeen: string }>();
    for (const r of failedRows) {
      const raw = (r.error_message || "").trim();
      const category = categorizeError(raw, r.status as string);
      categoryMap.set(category, (categoryMap.get(category) ?? 0) + 1);

      const key = (raw || `(${category})`).slice(0, 200);
      const cur = messageMap.get(key) || { message: key, count: 0, category, lastSeen: r.created_at as string };
      cur.count++;
      if ((r.created_at as string) > cur.lastSeen) cur.lastSeen = r.created_at as string;
      messageMap.set(key, cur);
    }
    const errorCategories = Array.from(categoryMap.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);
    const topErrorMessages = Array.from(messageMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Suppression count
    const { count: suppressedCount } = await adminClient
      .from("suppressed_emails")
      .select("id", { count: "exact", head: true });

    return json({
      rangeDays: days,
      kpis: {
        total,
        totalSent,
        totalFailed,
        totalBounced,
        totalPending,
        totalSuppressed,
        suppressedTotal: suppressedCount ?? 0,
        deliveryRate,
        uniqueRecipients,
        topErrorCategory: errorCategories[0]?.category ?? null,
        topErrorCategoryCount: errorCategories[0]?.count ?? 0,
        distinctErrorCategories: errorCategories.length,
      },
      series,
      templateSummary,
      recent,
      errorCategories,
      topErrorMessages,
    }, 200);
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

function categorizeError(message: string, status: string): string {
  const m = (message || "").toLowerCase();
  if (!m) {
    if (status === "bounced") return "Bounce";
    if (status === "dlq") return "Dead Letter";
    return "Unknown";
  }
  if (m.includes("bounce") || m.includes("undeliverable") || m.includes("mailbox") && m.includes("full")) return "Bounce";
  if (m.includes("invalid") && (m.includes("email") || m.includes("address") || m.includes("recipient"))) return "Invalid Recipient";
  if (m.includes("does not exist") || m.includes("no such user") || m.includes("user unknown") || m.includes("550")) return "Invalid Recipient";
  if (m.includes("suppress") || m.includes("unsubscribe") || m.includes("complaint") || m.includes("spam")) return "Suppressed / Complaint";
  if (m.includes("rate limit") || m.includes("too many") || m.includes("429") || m.includes("throttle")) return "Rate Limited";
  if (m.includes("timeout") || m.includes("timed out") || m.includes("etimedout")) return "Timeout";
  if (m.includes("dns") || m.includes("enotfound") || m.includes("getaddrinfo")) return "DNS / Network";
  if (m.includes("network") || m.includes("econnrefused") || m.includes("econnreset") || m.includes("socket")) return "DNS / Network";
  if (m.includes("auth") || m.includes("unauthorized") || m.includes("api key") || m.includes("forbidden") || m.includes("401") || m.includes("403")) return "Auth / API Key";
  if (m.includes("template") || m.includes("render")) return "Template Error";
  if (m.includes("attachment") || m.includes("payload") || m.includes("size")) return "Payload / Size";
  if (m.includes("smtp") || m.includes("relay")) return "SMTP / Relay";
  if (m.includes("5xx") || m.includes("server error") || m.includes("500") || m.includes("502") || m.includes("503")) return "Provider 5xx";
  if (m.includes("4xx") || m.includes("400") || m.includes("422")) return "Provider 4xx";
  return "Other";
}