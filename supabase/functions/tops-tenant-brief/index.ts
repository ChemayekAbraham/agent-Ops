// tops-tenant-brief — a short, AI-generated summary of one tenant's rent
// plan (Tenant Ops Workspace). Per docs/TOPS_RULES.md: additive only, no
// existing function/table/file is changed. New object, own tops_ table.
//
// AUTH: the anon-key JWT gateway check (verify_jwt, default true — no
// supabase/config.toml entry needed or added) is not trusted alone. This
// function independently validates the bearer token against Supabase auth
// via a service-role admin client (adminClient.auth.getUser(token)) and
// rejects anything that isn't a real, live user — deliberately NOT the
// weaker pattern seen elsewhere in this codebase (some existing functions
// only check that an Authorization header is present, or trust a
// client-supplied user id, without ever validating the token). Role
// membership is then checked server-side via has_role(_user_id, _role) —
// the same six-role tops_ gate as every other object in this build — never
// inferred from anything the client sent.
//
// FACT-GATHERING: tops_plan_position() and tops_plan_schedule_ledger() are
// both has_role(auth.uid(), ...)-gated exactly like every other client-facing
// tops_ RPC. Rather than adding a new internal/ungated variant for either
// (out of scope for an edge-function-only task), this function calls them
// through a second client built with the CALLER's own forwarded bearer
// token (anon key + Authorization header) — auth.uid() then resolves
// correctly inside those functions' own existing gate, which we already
// independently confirmed passes. tops_promises_to_pay, the cc_* contact
// history, and this function's own tops_tenant_brief_log table are all read
// or written via the service-role admin client, which is appropriate here
// only because the caller's role was already verified above.
//
// GENERATION: facts are sent to the Lovable AI gateway with a system prompt
// that forbids inventing or altering any number and requires Rent
// Plan/Supporter/Returns and "UGX <figure>". The response is then validated:
// every "UGX <number>" the model wrote must equal — digit for digit, after
// stripping thousands separators — one of the UGX figures actually supplied.
// A single mismatch, or any gateway/parsing failure, degrades the response
// to facts-only (narrative: null) rather than ever returning an unverified
// number. This is deliberately the ONLY thing hard-validated (per the
// brief's own wording, "every UGX figure"): non-monetary counts like
// days-past-due are supplied as facts too, but are not currency figures and
// are not subject to this specific check.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const OPS_ROLES = ["tenant_ops", "operations", "coo", "cfo", "ceo", "super_admin"] as const;
const RATE_LIMIT_PER_HOUR = 30;
const MODEL = "google/gemini-2.5-flash";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const fmtUgx = (n: number) => `UGX ${Math.round(n).toLocaleString("en-US")}`;

interface Facts {
  as_at: string;
  basis: string;
  tenant_name: string | null;
  cadence: string;
  days_past_due: number | null;
  term_expired: boolean;
  outstanding_ugx: number;
  expected_to_date_ugx: number;
  paid_to_date_ugx: number;
  catch_up_daily_ugx: number | null;
  missed_instalments_count: number;
  total_instalments_count: number;
  last_promise: {
    promised_amount_ugx: number;
    promised_date: string;
    channel: string;
    status: string;
  } | null;
  last_contact_at: string | null;
  last_contact_outcome: string | null;
  total_contact_attempts: number;
}

function moneyFacts(f: Facts): number[] {
  const values = [f.outstanding_ugx, f.expected_to_date_ugx, f.paid_to_date_ugx];
  if (f.catch_up_daily_ugx != null) values.push(f.catch_up_daily_ugx);
  if (f.last_promise) values.push(f.last_promise.promised_amount_ugx);
  return values.map((v) => Math.round(v));
}

function factsToPrompt(f: Facts): string {
  const lines = [
    `As at: ${f.as_at} (${f.basis})`,
    `Tenant: ${f.tenant_name ?? "Unnamed"}`,
    `Cadence: ${f.cadence}`,
    `Days past due: ${f.days_past_due ?? "unknown (cadence not locked)"}`,
    `Term expired: ${f.term_expired ? "yes" : "no"}`,
    `Outstanding: ${fmtUgx(f.outstanding_ugx)}`,
    `Expected to date: ${fmtUgx(f.expected_to_date_ugx)}`,
    `Paid to date: ${fmtUgx(f.paid_to_date_ugx)}`,
    f.catch_up_daily_ugx != null ? `Daily catch-up needed: ${fmtUgx(f.catch_up_daily_ugx)}` : null,
    `Missed instalments: ${f.missed_instalments_count} of ${f.total_instalments_count}`,
    f.last_promise
      ? `Last promise: ${fmtUgx(f.last_promise.promised_amount_ugx)} by ${f.last_promise.promised_date} via ${f.last_promise.channel} (status: ${f.last_promise.status})`
      : "Last promise: none on record",
    f.last_contact_at
      ? `Last contact: ${f.last_contact_at}, outcome: ${f.last_contact_outcome ?? "unrecorded"}`
      : "Last contact: none on record",
    `Total contact attempts: ${f.total_contact_attempts}`,
  ].filter(Boolean);
  return lines.join("\n");
}

const SYSTEM_PROMPT = `You write a short internal briefing for a tenant-ops officer about one Rent Plan, from facts supplied below. Rules, no exceptions:
- Never invent, estimate, round differently, or alter any number. Use only the exact figures given to you, written exactly as given (e.g. "UGX 191,040", never "UGX 191,000" or "about 190,000").
- Every money figure must be written as "UGX" immediately followed by the exact figure from the facts. Never write UGX after the number, never omit UGX.
- Use "Rent Plan", "Supporter", and "Returns" — never "loan", "lender", "ROI", or "interest".
- Do not mention specific calendar dates; describe timing in relative terms only (e.g. "recently", "on the date promised", "before this call").
- No emojis, no markdown, no bullet points — four sentences of plain prose, no more.
- Sentence 1: what they currently owe. Sentence 2: how they have behaved (missed instalments, days past due). Sentence 3: what was last promised, if anything. Sentence 4: what the officer should ask for on this call.
- If a fact is missing or unknown, say so plainly rather than guessing.`;

async function hasAnyOpsRole(admin: ReturnType<typeof createClient>, userId: string): Promise<boolean> {
  const checks = await Promise.all(
    OPS_ROLES.map((role) =>
      admin.rpc("has_role", { _user_id: userId, _role: role }).then(({ data }) => data === true).catch(() => false)
    ),
  );
  return checks.some(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await admin.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    if (!(await hasAnyOpsRole(admin, user.id))) {
      return json({ error: "Not authorized for this workspace" }, 403);
    }

    const body = await req.json().catch(() => null) as { rent_request_id?: string } | null;
    const rentRequestId = body?.rent_request_id;
    if (!rentRequestId || typeof rentRequestId !== "string") {
      return json({ error: "rent_request_id is required" }, 400);
    }

    // Rate limit: this table doubles as its own rate-limit ledger.
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: recentCount } = await admin
      .from("tops_tenant_brief_log")
      .select("id", { count: "exact", head: true })
      .eq("requested_by", user.id)
      .gte("requested_at", since);
    if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
      return json({ error: "Rate limit reached — try again later." }, 429);
    }

    // A client authenticated AS the caller — so tops_plan_position() and
    // tops_plan_schedule_ledger()'s own has_role(auth.uid(), ...) gate
    // resolves correctly, without needing an ungated internal variant.
    const asCaller = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: rr, error: rrError } = await admin
      .from("rent_requests")
      .select("id, tenant_id")
      .eq("id", rentRequestId)
      .maybeSingle();
    if (rrError) throw rrError;
    if (!rr) return json({ error: "Plan not found" }, 404);

    const { data: tenantProfile } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", rr.tenant_id)
      .maybeSingle();

    const { data: positionRows, error: posError } = await asCaller
      .rpc("tops_plan_position", { p_rent_request_id: rentRequestId, p_as_at: null });
    if (posError) throw posError;
    const position = (positionRows ?? [])[0];
    if (!position) return json({ error: "No position could be computed for this plan" }, 404);

    const { data: ledger, error: ledgerError } = await asCaller
      .rpc("tops_plan_schedule_ledger", { p_rent_request_id: rentRequestId });
    if (ledgerError) throw ledgerError;
    const ledgerRows = (ledger ?? []) as { outstanding_ugx: number; never_billed: boolean }[];
    const billedRows = ledgerRows.filter((r) => !r.never_billed);
    const missedInstalmentsCount = billedRows.filter((r) => Number(r.outstanding_ugx) > 0).length;

    const { data: lastPromise } = await admin
      .from("tops_promises_to_pay")
      .select("promised_amount_ugx, promised_date, channel, status")
      .eq("rent_request_id", rentRequestId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    // Contact history: the real cc_* spine (keyed by tenant_id, not
    // rent_request_id — confirmed live) plus our own richer tops_call_outcomes
    // log (keyed by rent_request_id), taking whichever is more recent.
    let lastContactAt: string | null = null;
    let lastContactOutcome: string | null = null;
    let totalContactAttempts = 0;

    const { data: cycleRows } = await admin
      .from("cc_cycle_rows")
      .select("id")
      .eq("subject_type", "tenant")
      .eq("subject_id", rr.tenant_id);
    const cycleRowIds = (cycleRows ?? []).map((r: { id: string }) => r.id);

    if (cycleRowIds.length > 0) {
      const { count: attemptCount } = await admin
        .from("cc_call_attempts")
        .select("id", { count: "exact", head: true })
        .in("cycle_row_id", cycleRowIds);
      totalContactAttempts = attemptCount ?? 0;

      const { data: lastAttempt } = await admin
        .from("cc_call_attempts")
        .select("revealed_at, outcome")
        .in("cycle_row_id", cycleRowIds)
        .order("revealed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (lastAttempt) {
        lastContactAt = lastAttempt.revealed_at;
        lastContactOutcome = lastAttempt.outcome;
      }
    }

    const { data: lastOutcome } = await admin
      .from("tops_call_outcomes")
      .select("recorded_at, outcome")
      .eq("rent_request_id", rentRequestId)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastOutcome && (!lastContactAt || new Date(lastOutcome.recorded_at) > new Date(lastContactAt))) {
      lastContactAt = lastOutcome.recorded_at;
      lastContactOutcome = lastOutcome.outcome;
    }

    const facts: Facts = {
      as_at: position.as_at,
      basis: position.basis,
      tenant_name: tenantProfile?.full_name ?? null,
      cadence: position.cadence,
      days_past_due: position.days_past_due,
      term_expired: !!position.term_expired,
      outstanding_ugx: Number(position.outstanding_ugx ?? 0),
      expected_to_date_ugx: Number(position.expected_to_date_ugx ?? 0),
      paid_to_date_ugx: Number(position.paid_to_date_ugx ?? 0),
      catch_up_daily_ugx: position.catch_up_daily_ugx != null ? Number(position.catch_up_daily_ugx) : null,
      missed_instalments_count: missedInstalmentsCount,
      total_instalments_count: billedRows.length,
      last_promise: lastPromise
        ? {
          promised_amount_ugx: Number(lastPromise.promised_amount_ugx),
          promised_date: lastPromise.promised_date,
          channel: lastPromise.channel,
          status: lastPromise.status,
        }
        : null,
      last_contact_at: lastContactAt,
      last_contact_outcome: lastContactOutcome,
      total_contact_attempts: totalContactAttempts,
    };

    const allowedMoney = new Set(moneyFacts(facts));

    let narrative: string | null = null;
    let degraded = true;
    let errorDetail: string | null = null;

    if (!lovableKey) {
      errorDetail = "AI gateway not configured";
    } else {
      try {
        const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: factsToPrompt(facts) },
            ],
          }),
        });

        if (aiRes.status === 429) {
          errorDetail = "AI gateway rate limited";
        } else if (aiRes.status === 402) {
          errorDetail = "AI gateway quota exhausted";
        } else if (!aiRes.ok) {
          errorDetail = `AI gateway status ${aiRes.status}`;
        } else {
          const payload = await aiRes.json();
          const text: string = (payload?.choices?.[0]?.message?.content ?? "").trim();

          // Every "UGX <number>" the model wrote must equal, digit for
          // digit (after stripping thousands separators), a figure we
          // actually supplied. A single mismatch degrades to facts-only.
          const mentioned = [...text.matchAll(/UGX\s*([\d,]+)/gi)].map((m) => Number(m[1].replace(/,/g, "")));
          const allMatch = mentioned.length > 0 && mentioned.every((n) => allowedMoney.has(n));

          if (!allMatch) {
            errorDetail = mentioned.length === 0
              ? "model output carried no UGX figure"
              : "model output contained an unverified UGX figure";
          } else {
            // Soft safety cap — the prompt already asks for four sentences.
            const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
            narrative = sentences.slice(0, 4).join(" ");
            degraded = false;
          }
        }
      } catch {
        errorDetail = "network failure reaching the AI gateway";
      }
    }

    await admin.from("tops_tenant_brief_log").insert({
      rent_request_id: rentRequestId,
      requested_by: user.id,
      model: MODEL,
      validation_passed: !degraded,
      degraded_to_facts_only: degraded,
      sentence_count: narrative ? narrative.split(/(?<=[.!?])\s+/).filter(Boolean).length : null,
      error_detail: errorDetail,
    });

    return json({
      rent_request_id: rentRequestId,
      generated_at: new Date().toISOString(),
      narrative,
      degraded,
      facts,
    });
  } catch (err) {
    console.error("[tops-tenant-brief]", err instanceof Error ? err.message : err);
    return json({ error: "Could not generate a brief right now." }, 500);
  }
});
