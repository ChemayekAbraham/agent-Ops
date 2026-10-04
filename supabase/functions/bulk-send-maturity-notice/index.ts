import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fmtDate = (iso: string | null | undefined): string => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" });
};

const fmtIsoDay = (iso: string | null | undefined): string => {
  if (!iso) return "none";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "none";
  return d.toISOString().slice(0, 10);
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function buildTemplateData(opts: {
  partner_name: string;
  partnership_reference: string;
  portfolio_id: string;
  partnership_amount: number;
  start_date: string;
  maturity_date: string;
  currency: string;
  renew_url?: string;
  redeem_url?: string;
}) {
  return {
    partner_name: opts.partner_name,
    partnership_reference: opts.partnership_reference,
    portfolio_id: opts.portfolio_id,
    partnership_amount: opts.partnership_amount,
    start_date: opts.start_date,
    maturity_date: opts.maturity_date,
    currency: opts.currency,
    company_name: "Welile",
    logo_url: "https://welileapp.com/welile-logo.png",
    dashboard_url: "https://welileapp.com/auth",
    renew_url: opts.renew_url || "",
    redeem_url: opts.redeem_url || "",
    unsubscribe_url: "https://welile.com/unsubscribe",
    terms_url: "https://welileapp.com/partners-terms",
    privacy_url: "https://welileapp.com/privacy",
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing authorization header" }, 401);

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: callerError } = await userClient.auth.getUser();
    if (callerError || !caller) return json({ error: "Unauthorized" }, 401);

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    // COO / Manager / Super Admin / CTO / Partner-Ops guard
    const [{ data: managerRoles, error: roleErr }, { data: staffPerms, error: permErr }] = await Promise.all([
      adminClient.from("user_roles").select("role")
        .eq("user_id", caller.id).in("role", ["manager", "coo", "super_admin", "cto"]),
      adminClient.from("staff_permissions").select("permitted_dashboard")
        .eq("user_id", caller.id).eq("permitted_dashboard", "partner-ops"),
    ]);
    if (roleErr) return json({ error: `Role check failed: ${roleErr.message}` }, 500);
    if (permErr) return json({ error: `Permission check failed: ${permErr.message}` }, 500);
    const hasRole = (managerRoles?.length ?? 0) > 0;
    const hasPartnerOps = (staffPerms?.length ?? 0) > 0;
    if (!hasRole && !hasPartnerOps) {
      return json({ error: "Only Welile Operations (COO, Manager, Super Admin, Partner Ops) can perform this action" }, 403);
    }

    const body = await req.json().catch(() => ({})) as {
      test?: boolean;
      testEmail?: string;
      partnerIds?: string[];
      portfolioIds?: string[];
      stream?: boolean;
    };

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    type Outcome = "sent" | "suppressed" | "rate_limited" | "failed";

    // Send a single email, retrying when the email service rate-limits us.
    // Returns a precise outcome so the caller can tally categories.
    const dispatch = async (payload: Record<string, unknown>): Promise<Outcome> => {
      const MAX_ATTEMPTS = 4;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const res = await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${supabaseServiceKey}`,
            },
            body: JSON.stringify(payload),
          });
          const txt = await res.text().catch(() => "");

          if (res.ok) {
            // The email service returns 200 with success:false when the
            // recipient is on the suppression list (bounced/unsubscribed).
            let parsed: any = null;
            try { parsed = JSON.parse(txt); } catch { /* ignore */ }
            if (parsed && parsed.success === false) {
              return /suppress/i.test(String(parsed.reason)) ? "suppressed" : "failed";
            }
            return "sent";
          }

          const isRateLimit = res.status === 429 || /rate ?limit/i.test(txt);
          if (isRateLimit && attempt < MAX_ATTEMPTS) {
            // Honour Retry-After when present, otherwise back off progressively.
            const headerMs = Number(res.headers.get("retry-after")) * 1000;
            const bodyMs = Number(txt.match(/(\d+)\s*ms/i)?.[1]);
            const waitMs = Math.min(
              Number.isFinite(headerMs) && headerMs > 0 ? headerMs : (bodyMs || attempt * 2000),
              5000,
            );
            await sleep(waitMs);
            continue;
          }
          console.warn("[bulk-send-maturity-notice] send failed:", res.status, txt);
          return isRateLimit ? "rate_limited" : "failed";
        } catch (e) {
          const msg = String(e);
          const isRateLimit = /rate ?limit/i.test(msg);
          if (isRateLimit && attempt < MAX_ATTEMPTS) {
            const bodyMs = Number(msg.match(/(\d+)\s*ms/i)?.[1]);
            await sleep(Math.min(bodyMs || attempt * 2000, 5000));
            continue;
          }
          console.warn("[bulk-send-maturity-notice] send threw:", e);
          return isRateLimit ? "rate_limited" : "failed";
        }
      }
      return "rate_limited";
    };

    // ─── TEST MODE: single sample email ───
    if (body.test) {
      const testEmail = (body.testEmail || "").trim();
      if (!testEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testEmail)) {
        return json({ error: "A valid testEmail is required for test mode" }, 400);
      }
      const now = new Date();
      const maturity = new Date(now);
      maturity.setMonth(maturity.getMonth() + 12);
      const ok = await dispatch({
        templateName: "partnership-maturity-notice",
        recipientEmail: testEmail,
        idempotencyKey: `partnership-maturity-notice-test-${Date.now()}`,
        templateData: buildTemplateData({
          partner_name: "Sarah Nakato",
          partnership_reference: "PF-TEST-001",
          portfolio_id: "PF-TEST-001",
          partnership_amount: 5_600_000,
          start_date: fmtDate(now.toISOString()),
          maturity_date: fmtDate(maturity.toISOString()),
          currency: "UGX",
          renew_url: "https://welileapp.com/portfolios/PF-TEST-001/renew",
          redeem_url: "https://welileapp.com/portfolios/PF-TEST-001/redeem",
        }),
      });
      return json({ ok: ok === "sent", outcome: ok, test: true, recipient: testEmail }, ok === "sent" ? 200 : 502);
    }

    // ─── BULK MODE ───
    // Preferred: send to the EXACT expiring portfolios listed in the dialog
    // (one notice per portfolio). Falls back to partner-level for back-compat.
    const portfolioIds = Array.isArray(body.portfolioIds)
      ? body.portfolioIds.filter((id) => typeof id === "string" && UUID.test(id))
      : null;
    const partnerIds = Array.isArray(body.partnerIds)
      ? body.partnerIds.filter((id) => typeof id === "string" && UUID.test(id))
      : null;

    const SELECT_COLS = "id, portfolio_code, account_name, investment_amount, created_at, maturity_date, display_currency, status, investor_id, agent_id";
    const portfolios: any[] = [];
    const CHUNK = 80;

    if (portfolioIds && portfolioIds.length > 0) {
      // Exact match on the portfolios shown in the dialog.
      for (let i = 0; i < portfolioIds.length; i += CHUNK) {
        const batch = portfolioIds.slice(i, i + CHUNK);
        const { data, error: pErr } = await adminClient
          .from("investor_portfolios")
          .select(SELECT_COLS)
          .not("maturity_date", "is", null)
          .in("id", batch);
        if (pErr) return json({ error: `Failed to load portfolios: ${pErr.message}` }, 500);
        if (data) portfolios.push(...data);
      }
    } else if (partnerIds && partnerIds.length > 0) {
      // Chunk investor_id filter to avoid exceeding the request URL length limit.
      for (let i = 0; i < partnerIds.length; i += CHUNK) {
        const batch = partnerIds.slice(i, i + CHUNK);
        const { data, error: pErr } = await adminClient
          .from("investor_portfolios")
          .select(SELECT_COLS)
          .not("maturity_date", "is", null)
          .in("status", ["active", "funded", "repaying"])
          .in("investor_id", batch);
        if (pErr) return json({ error: `Failed to load portfolios: ${pErr.message}` }, 500);
        if (data) portfolios.push(...data);
      }
    } else {
      const { data, error: pErr } = await adminClient
        .from("investor_portfolios")
        .select(SELECT_COLS)
        .not("maturity_date", "is", null)
        .in("status", ["active", "funded", "repaying"]);
      if (pErr) return json({ error: `Failed to load portfolios: ${pErr.message}` }, 500);
      if (data) portfolios.push(...data);
    }

    if (!portfolios || portfolios.length === 0) {
      return json({ ok: true, sent: 0, skipped: 0, suppressed: 0, rateLimited: 0, failed: 0, total: 0, message: "No matching partnerships with a maturity date" }, 200);
    }

    // Resolve recipient emails in one batch.
    const recipientIds = Array.from(
      new Set(portfolios.map((p: any) => p.investor_id || p.agent_id).filter(Boolean)),
    ) as string[];
    const profileMap = new Map<string, { email: string | null; full_name: string | null }>();
    const PCHUNK = 80;
    for (let i = 0; i < recipientIds.length; i += PCHUNK) {
      const batch = recipientIds.slice(i, i + PCHUNK);
      const { data: profiles } = await adminClient
        .from("profiles")
        .select("id, email, full_name")
        .in("id", batch);
      for (const pr of profiles ?? []) profileMap.set(pr.id, { email: pr.email, full_name: pr.full_name });
    }

    const total = portfolios.length;
    const counts = { queued: total, sent: 0, skipped: 0, suppressed: 0, rateLimited: 0, failed: 0, processed: 0 };

    // Process one portfolio, updating counts. Returns nothing; mutates `counts`.
    const processOne = async (p: any) => {
      const recipientId = p.investor_id || p.agent_id;
      const profile = recipientId ? profileMap.get(recipientId) : null;
      const email = profile?.email?.trim();
      if (!email) { counts.skipped++; counts.processed++; return; }

      const ref = p.portfolio_code || `PF-${String(p.id).replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      const outcome = await dispatch({
        templateName: "partnership-maturity-notice",
        recipientEmail: email,
        idempotencyKey: `partnership-maturity-notice-${p.id}-${fmtIsoDay(p.maturity_date)}`,
        templateData: buildTemplateData({
          partner_name: profile?.full_name || "Partner",
          partnership_reference: ref,
          portfolio_id: ref,
          partnership_amount: Number(p.investment_amount) || 0,
          start_date: fmtDate(p.created_at),
          maturity_date: fmtDate(p.maturity_date),
          currency: p.display_currency || "UGX",
          renew_url: `https://welileapp.com/portfolios/${p.id}/renew`,
          redeem_url: `https://welileapp.com/portfolios/${p.id}/redeem`,
        }),
      });
      if (outcome === "sent") counts.sent++;
      else if (outcome === "suppressed") counts.suppressed++;
      else if (outcome === "rate_limited") counts.rateLimited++;
      else counts.failed++;
      counts.processed++;
    };

    // ─── STREAMING MODE: emit NDJSON progress lines as we send ───
    if (body.stream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const emit = (obj: Record<string, unknown>) =>
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          try {
            emit({ type: "progress", ...counts });
            for (const p of portfolios as any[]) {
              await processOne(p);
              emit({ type: "progress", ...counts });
              await sleep(150); // pace to stay under the email rate limit
            }
            emit({ type: "done", ok: true, total, ...counts });
          } catch (e) {
            emit({ type: "error", error: (e as Error)?.message || "Unexpected error", ...counts });
          } finally {
            controller.close();
          }
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
      });
    }

    // ─── NON-STREAM MODE: process all, return summary JSON ───
    for (const p of portfolios as any[]) {
      await processOne(p);
      await sleep(150);
    }
    return json({ ok: true, total, ...counts }, 200);
  } catch (err) {
    console.error("[bulk-send-maturity-notice] fatal:", err);
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});