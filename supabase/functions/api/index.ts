// ─────────────────────────────────────────────────────────────────────────────
// Welile Public REST API — v1
//
// A single, versioned REST gateway consumed by the Welile Flutter application.
// Served by Supabase Edge Functions and reachable as:
//   • https://api.welileapp.com/api/v1/...           (custom-domain proxy)
//   • https://<project>.functions.supabase.co/functions/v1/api/v1/...  (direct)
//
// Every response uses a stable envelope so the Flutter client can decode it the
// same way regardless of endpoint:
//   { "status": "success" | "error", "message": string, "data": <payload|null> }
//
// Auth: `POST /api/v1/auth/login` is public and mints a Supabase session
// (access_token + refresh_token). All other endpoints require the
// `Authorization: Bearer <access_token>` header.
// ─────────────────────────────────────────────────────────────────────────────
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// deno-lint-ignore no-explicit-any
type AnyClient = any;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DEPOSIT_PURPOSES = [
  "operational_float",
  "personal_deposit",
  "partnership_deposit",
  "personal_rent_repayment",
  "other",
] as const;

// ── Response helpers ─────────────────────────────────────────────────────────
function ok(data: unknown, message = "OK", status = 200) {
  return new Response(
    JSON.stringify({ status: "success", message, data }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

function fail(message: string, status = 400, data: unknown = null) {
  return new Response(
    JSON.stringify({ status: "error", message, data }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

// ── Input helpers ────────────────────────────────────────────────────────────
function toAmount(value: unknown): number | null {
  const n = typeof value === "string" ? parseFloat(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 100_000_000) return null;
  return Math.round(n);
}

function phoneVariants(raw: string): string[] {
  const digits = raw.replace(/\D/g, "");
  const last9 = digits.slice(-9);
  const set = new Set<string>([raw.trim(), digits, `0${last9}`, `256${last9}`, last9]);
  return [...set].filter(Boolean);
}

// Extract the API sub-path (`/v1/...`) regardless of how the function is mounted
// (direct `/functions/v1/api/api/v1/...`, custom-domain `/api/v1/...`, etc.).
// We anchor on the version segment so all mount prefixes collapse to `/v1/...`.
function apiPath(url: URL): string {
  const p = url.pathname.replace(/\/+$/, "");
  const idx = p.indexOf("/v1");
  if (idx >= 0) return p.slice(idx) || "/";
  return "/";
}

// Resolve the caller from the Bearer token. Returns the user + a request-scoped
// client that carries the caller's JWT so RLS applies as that user.
async function authenticate(req: Request): Promise<
  { user: AnyClient; userClient: AnyClient } | null
> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) return null;
  return { user: data.user, userClient };
}

// ── Endpoint: POST /v1/auth/login ────────────────────────────────────────────
async function handleLogin(req: Request): Promise<Response> {
  let body: AnyClient;
  try { body = await req.json(); } catch { return fail("Invalid JSON body", 400); }

  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) return fail("Password is required", 400);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Accept either an email or a phone number as the identifier. A single phone
  // can resolve to more than one auth identity (e.g. a synthetic `@welile.user`
  // placeholder AND a real email), so we collect every candidate and prefer the
  // real email, then try each until the password matches.
  const candidates: string[] = [];
  const rawEmail = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const rawPhone = typeof body?.phone === "string" ? body.phone.trim() : "";

  if (rawEmail.includes("@")) {
    candidates.push(rawEmail);
  } else if (rawPhone) {
    const { data: resolved } = await admin.rpc("get_email_by_phone", {
      phone_variants: phoneVariants(rawPhone),
    });
    // A SETOF-scalar RPC comes back as [{ get_email_by_phone: "..." }]; also
    // tolerate plain-string or plain-array shapes.
    const list = Array.isArray(resolved) ? resolved : resolved ? [resolved] : [];
    for (const e of list) {
      const val = typeof e === "string" ? e : (e && typeof e === "object" ? Object.values(e)[0] : null);
      if (typeof val === "string" && val) candidates.push(val.toLowerCase());
    }
  }
  if (candidates.length === 0) return fail("No account found for that phone or email", 401);

  const isSynthetic = (e: string) => e.endsWith("@welile.user") || e.endsWith("@welile.agent");
  const ordered = [...new Set(candidates)].sort((a, b) =>
    Number(isSynthetic(a)) - Number(isSynthetic(b))
  );

  // Public anon client to actually mint the session.
  const publicClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let signIn: AnyClient = null;
  for (const candidate of ordered) {
    const { data, error } = await publicClient.auth.signInWithPassword({ email: candidate, password });
    if (!error && data?.session) { signIn = data; break; }
  }
  if (!signIn?.session) return fail("Invalid phone/email or password", 401);

  const { session, user } = signIn;
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, phone, avatar_url, city, country")
    .eq("id", user.id)
    .maybeSingle();
  const { data: roleRows } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);
  const roles = (roleRows ?? []).map((r: AnyClient) => r.role);

  return ok(
    {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      token_type: "bearer",
      expires_at: session.expires_at,
      expires_in: session.expires_in,
      user: {
        id: user.id,
        email: user.email,
        full_name: profile?.full_name ?? null,
        phone: profile?.phone ?? null,
        avatar_url: profile?.avatar_url ?? null,
        roles,
      },
    },
    "Login successful",
  );
}

// ── Endpoint: GET /v1/auth/me ────────────────────────────────────────────────
async function handleMe(ctx: { user: AnyClient }): Promise<Response> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: profile } = await admin
    .from("profiles")
    .select("id, full_name, phone, email, avatar_url, national_id, city, country, territory, created_at")
    .eq("id", ctx.user.id)
    .maybeSingle();
  const { data: roleRows } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", ctx.user.id);
  const roles = (roleRows ?? []).map((r: AnyClient) => r.role);
  return ok({ ...(profile ?? { id: ctx.user.id }), roles }, "Profile loaded");
}

// Fetch wallet buckets + strict available balance for a user.
async function loadWallet(admin: AnyClient, userId: string) {
  const { data: wallet } = await admin
    .from("wallets")
    .select("withdrawable_balance, float_balance, advance_balance, locked_balance, currency")
    .eq("user_id", userId)
    .maybeSingle();
  const { data: available } = await admin.rpc("get_user_available_balance", { p_user_id: userId });
  const availableNum = typeof available === "number" ? available : Number(available ?? 0);
  return {
    currency: "UGX",
    available_balance: Math.max(0, Math.round(availableNum || 0)),
    withdrawable_balance: Math.round(Number(wallet?.withdrawable_balance ?? 0)),
    float_balance: Math.round(Number(wallet?.float_balance ?? 0)),
    advance_balance: Math.round(Number(wallet?.advance_balance ?? 0)),
    locked_balance: Math.round(Number(wallet?.locked_balance ?? 0)),
  };
}

// ── Endpoint: GET /v1/wallets/bootstrap?role=agent ──────────────────────────
async function handleBootstrap(ctx: { user: AnyClient }, url: URL): Promise<Response> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userId = ctx.user.id;

  const [profileRes, rolesRes, walletData] = await Promise.all([
    admin
      .from("profiles")
      .select("id, full_name, phone, email, avatar_url, national_id, city, country, territory")
      .eq("id", userId)
      .maybeSingle(),
    admin.from("user_roles").select("role").eq("user_id", userId),
    loadWallet(admin, userId),
  ]);

  const roles = (rolesRes.data ?? []).map((r: AnyClient) => r.role);
  const requestedRole = url.searchParams.get("role");
  const activeRole = requestedRole && roles.includes(requestedRole)
    ? requestedRole
    : roles[0] ?? null;

  // Lightweight KPIs derived from the user-facing ledger.
  const since = new Date();
  since.setDate(since.getDate() - 30);
  const { data: recent } = await admin
    .from("general_ledger")
    .select("amount, direction")
    .eq("user_id", userId)
    .eq("ledger_scope", "wallet")
    .neq("classification", "admin_correction")
    .neq("category", "system_balance_correction")
    .gte("transaction_date", since.toISOString())
    .limit(1000);
  let inflow30d = 0, outflow30d = 0;
  for (const row of recent ?? []) {
    const amt = Number(row.amount ?? 0);
    if (row.direction === "cash_in") inflow30d += amt; else outflow30d += amt;
  }

  return ok(
    {
      profile: profileRes.data ?? { id: userId },
      roles,
      active_role: activeRole,
      wallet: walletData,
      kpis: {
        inflow_30d: Math.round(inflow30d),
        outflow_30d: Math.round(outflow30d),
        net_30d: Math.round(inflow30d - outflow30d),
      },
    },
    "Dashboard bootstrap loaded",
  );
}

// ── Endpoint: GET /v1/wallets?page=1&limit=50 ────────────────────────────────
async function handleWallets(ctx: { user: AnyClient }, url: URL): Promise<Response> {
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const userId = ctx.user.id;

  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
  const from = (page - 1) * limit;
  const to = from + limit - 1;

  const [walletData, txRes] = await Promise.all([
    loadWallet(admin, userId),
    admin
      .from("general_ledger")
      .select("id, transaction_date, amount, direction, category, description, reference_id", { count: "exact" })
      .eq("user_id", userId)
      .eq("ledger_scope", "wallet")
      .neq("classification", "admin_correction")
      .neq("category", "system_balance_correction")
      .order("transaction_date", { ascending: false })
      .range(from, to),
  ]);

  const transactions = (txRes.data ?? []).map((t: AnyClient) => ({
    id: t.id,
    date: t.transaction_date,
    amount: Math.round(Number(t.amount ?? 0)),
    direction: t.direction,
    category: t.category,
    description: t.description,
    reference_id: t.reference_id,
  }));

  const total = txRes.count ?? transactions.length;
  return ok(
    {
      wallet: walletData,
      transactions,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.max(1, Math.ceil(total / limit)),
        has_more: to + 1 < total,
      },
    },
    "Wallet loaded",
  );
}

// ── Endpoint: POST /v1/wallets/deposits ──────────────────────────────────────
async function handleDeposit(ctx: { user: AnyClient }, req: Request): Promise<Response> {
  let body: AnyClient;
  try { body = await req.json(); } catch { return fail("Invalid JSON body", 400); }

  const amount = toAmount(body?.amount);
  if (!amount) return fail("A valid positive amount is required", 400);

  const provider = typeof body?.provider === "string" ? body.provider.trim() : null;
  const transactionId = typeof body?.transactionId === "string" ? body.transactionId.trim()
    : typeof body?.transaction_id === "string" ? body.transaction_id.trim() : null;
  if (!transactionId) return fail("A mobile money transaction ID (transactionId) is required", 400);

  const notes = typeof body?.notes === "string" ? body.notes.trim().slice(0, 500) : null;
  const rawPurpose = typeof body?.purpose === "string" ? body.purpose.trim() : "other";
  const purpose = (DEPOSIT_PURPOSES as readonly string[]).includes(rawPurpose) ? rawPurpose : "other";

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin
    .from("deposit_requests")
    .insert({
      user_id: ctx.user.id,
      amount,
      provider,
      transaction_id: transactionId,
      notes,
      deposit_purpose: purpose,
      status: "pending",
    })
    .select("id, amount, status, provider, transaction_id, deposit_purpose, created_at")
    .single();

  if (error) return fail(error.message ?? "Could not submit deposit", 400);
  return ok(
    {
      deposit_id: data.id,
      amount: Math.round(Number(data.amount)),
      status: data.status,
      provider: data.provider,
      transaction_id: data.transaction_id,
      purpose: data.deposit_purpose,
      created_at: data.created_at,
    },
    "Deposit submitted for verification",
    201,
  );
}

// ── Endpoint: POST /v1/wallets/withdrawals ───────────────────────────────────
async function handleWithdrawal(ctx: { user: AnyClient }, req: Request): Promise<Response> {
  let body: AnyClient;
  try { body = await req.json(); } catch { return fail("Invalid JSON body", 400); }

  const amount = toAmount(body?.amount);
  if (!amount) return fail("A valid positive amount is required", 400);

  const payoutMethod = typeof body?.payoutMethod === "string" ? body.payoutMethod.trim()
    : typeof body?.payout_method === "string" ? body.payout_method.trim() : "mobile_money";
  const provider = typeof body?.provider === "string" ? body.provider.trim() : null;
  const accountNumber = typeof body?.accountNumber === "string" ? body.accountNumber.trim()
    : typeof body?.account_number === "string" ? body.account_number.trim() : null;
  const accountName = typeof body?.accountName === "string" ? body.accountName.trim()
    : typeof body?.account_name === "string" ? body.account_name.trim() : null;
  const reason = typeof body?.reason === "string" ? body.reason.trim().slice(0, 500) : null;

  if (payoutMethod === "mobile_money" && !accountNumber) {
    return fail("accountNumber is required for mobile money payouts", 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Enforce the strict available-balance gate (single source of truth).
  const { data: available } = await admin.rpc("get_user_available_balance", { p_user_id: ctx.user.id });
  const availableNum = Math.max(0, Math.round(Number(available ?? 0)));
  if (amount > availableNum) {
    return fail(
      `Insufficient withdrawable balance. Available: UGX ${availableNum.toLocaleString()}`,
      400,
      { available_balance: availableNum, requested: amount },
    );
  }

  const insertRow: AnyClient = {
    user_id: ctx.user.id,
    amount,
    status: "pending",
    payout_method: payoutMethod,
    reason,
  };
  if (payoutMethod === "mobile_money") {
    insertRow.mobile_money_number = accountNumber;
    insertRow.mobile_money_provider = provider;
    insertRow.mobile_money_name = accountName;
  } else {
    insertRow.bank_name = provider;
    insertRow.bank_account_number = accountNumber;
    insertRow.bank_account_name = accountName;
  }

  const { data, error } = await admin
    .from("withdrawal_requests")
    .insert(insertRow)
    .select("id, amount, status, payout_method, created_at")
    .single();

  if (error) return fail(error.message ?? "Could not submit withdrawal", 400);
  return ok(
    {
      withdrawal_id: data.id,
      amount: Math.round(Number(data.amount)),
      status: data.status,
      payout_method: data.payout_method,
      created_at: data.created_at,
    },
    "Withdrawal submitted for review",
    201,
  );
}

// ── Router ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const path = apiPath(url);
  const method = req.method.toUpperCase();

  try {
    // Health check / API root.
    if (path === "/" || path === "/v1" || path === "/v1/health") {
      return ok({ name: "Welile API", version: "v1", status: "healthy" }, "Welile API is running");
    }

    // Public auth endpoint.
    if (path === "/v1/auth/login" && method === "POST") {
      return await handleLogin(req);
    }

    // Everything below requires a valid bearer token.
    const ctx = await authenticate(req);
    if (!ctx) return fail("Unauthorized — a valid access token is required", 401);

    if (path === "/v1/auth/me" && method === "GET") return await handleMe(ctx);
    if (path === "/v1/wallets/bootstrap" && method === "GET") return await handleBootstrap(ctx, url);
    if (path === "/v1/wallets" && method === "GET") return await handleWallets(ctx, url);
    if (path === "/v1/wallets/deposits" && method === "POST") return await handleDeposit(ctx, req);
    if (path === "/v1/wallets/withdrawals" && method === "POST") return await handleWithdrawal(ctx, req);

    return fail(`No route for ${method} ${path}`, 404);
  } catch (err) {
    console.error("[api] Unhandled error:", err);
    return fail("Internal server error", 500);
  }
});