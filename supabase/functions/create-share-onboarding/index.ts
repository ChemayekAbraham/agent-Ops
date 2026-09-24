import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import {
  ANGEL_PRICE_PER_SHARE, ANGEL_TOTAL_SHARES, computeAngelShares, newAngelReference, sharesCommitted,
} from "../_shared/angelPoolShares.ts";
import { issueShareInvite } from "../_shared/shareOnboardingInvite.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const Body = z.object({
  amount: z.number().int().min(ANGEL_PRICE_PER_SHARE),
  shareholderId: z.string().uuid().optional(),
  newPerson: z.object({
    fullName: z.string().trim().min(3).max(120),
    phone: z.string().trim().min(7).max(32),
    email: z.string().trim().email().max(200),
  }).optional(),
}).refine((b) => !!b.shareholderId !== !!b.newPerson, { message: "Pick a user or enter a new person" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: { user } } = await admin.auth.getUser(token);
    if (!user) return json({ error: "Unauthorized" }, 401);
    const { data: isOps } = await admin.rpc("is_partner_ops", { _uid: user.id });
    if (!isOps) return json({ error: "Only Partner Operations can create shares" }, 403);

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, 400);
    const { amount, newPerson } = parsed.data;
    let shareholderId = parsed.data.shareholderId;

    if (newPerson) {
      const email = newPerson.email.toLowerCase();
      const { data: existing } = await admin.from("profiles").select("id").ilike("email", email).maybeSingle();
      if (existing) {
        shareholderId = existing.id;
      } else {
        const pw = crypto.randomUUID() + "Aa1!";
        const { data: created, error } = await admin.auth.admin.createUser({
          email, password: pw, email_confirm: true,
          user_metadata: { full_name: newPerson.fullName, phone: newPerson.phone, role: "supporter", signup_source: "share-onboarding" },
        });
        if (error || !created.user) return json({ error: error?.message || "Could not create account" }, 400);
        shareholderId = created.user.id;
      }
    }

    const calc = computeAngelShares(amount);
    const committed = await sharesCommitted(admin);
    if (committed + calc.shares > ANGEL_TOTAL_SHARES) {
      return json({ error: `Only ${(ANGEL_TOTAL_SHARES - committed).toLocaleString()} shares remaining in the pool` }, 400);
    }

    const [{ data: prof }, { data: walletRow }] = await Promise.all([
      admin.from("profiles").select("full_name, phone, email").eq("id", shareholderId).maybeSingle(),
      admin.from("wallets").select("float_balance").eq("user_id", shareholderId).maybeSingle(),
    ]);

    const referenceId = newAngelReference();
    const { data: row, error: insErr } = await admin.from("share_onboarding_requests").insert({
      shareholder_id: shareholderId, created_by: user.id,
      amount: calc.amount, shares: calc.shares,
      pool_ownership_percent: calc.poolOwnershipPercent,
      company_ownership_percent: calc.companyOwnershipPercent,
      reference_id: referenceId,
      prefill_name: prof?.full_name || null, prefill_phone: prof?.phone || null, prefill_email: prof?.email || null,
    }).select("*").single();
    if (insErr) throw insErr;

    const origin = req.headers.get("origin") || "https://welileapp.com";
    const invite = await issueShareInvite(admin, row, origin, "1");

    await Promise.all([
      logSystemEvent(admin, "account_activated", shareholderId!, "share_onboarding_requests", row.id,
        { action: "share_onboarding.created", reference_id: referenceId, amount: calc.amount, shares: calc.shares, created_by: user.id, emailed: invite.emailed }),
      admin.from("audit_logs").insert({
        user_id: user.id, action_type: "share_onboarding_created", table_name: "share_onboarding_requests",
        record_id: row.id, reason: `Angel Pool shares created for shareholder (${referenceId})`,
        metadata: { amount: calc.amount, shares: calc.shares, shareholder_id: shareholderId },
      }),
    ]);

    return json({
      ok: true, id: row.id, reference_id: referenceId, shares: calc.shares,
      available_balance: Number(avail ?? 0), emailed: invite.emailed, email: invite.email, signing_url: invite.url,
    });
  } catch (e) {
    console.error("[create-share-onboarding]", (e as Error)?.message || e);
    return json({ error: "Could not create shares. Please try again." }, 500);
  }
});
