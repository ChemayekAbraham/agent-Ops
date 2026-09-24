import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import {
  ANGEL_POOL_PERCENT, ANGEL_PRICE_PER_SHARE, ANGEL_TOTAL_SHARES, formatAllocationDate, sharesCommitted,
} from "../_shared/angelPoolShares.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    id: z.string().uuid(),
    repName: z.string().trim().min(3).max(120),
    repPosition: z.string().trim().min(2).max(120),
    repSignature: z.string().startsWith("data:image/").max(700_000),
    pdfBase64: z.string().min(100).max(15_000_000),
  }),
  z.object({ action: z.literal("cancel"), id: z.string().uuid(), reason: z.string().trim().min(10).max(500) }),
]);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

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
    if (!isOps) return json({ error: "Only Partner Operations can do this" }, 403);

    const parsed = Body.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ") }, 400);
    const body = parsed.data;

    // Fresh read — never trust client state for a money transition.
    const { data: row } = await admin.from("share_onboarding_requests").select("*").eq("id", body.id).maybeSingle();
    if (!row) return json({ error: "Request not found" }, 404);

    if (body.action === "cancel") {
      if (!["awaiting_signature", "submitted"].includes(row.status)) return json({ error: "This request can no longer be cancelled" }, 400);
      const { error } = await admin.from("share_onboarding_requests")
        .update({ status: "cancelled", cancelled_reason: body.reason, token_hash: null })
        .eq("id", row.id).in("status", ["awaiting_signature", "submitted"]);
      if (error) throw error;
      await Promise.all([
        logSystemEvent(admin, "account_activated", row.shareholder_id, "share_onboarding_requests", row.id, { action: "share_onboarding.cancelled", reason: body.reason }),
        admin.from("audit_logs").insert({ user_id: user.id, action_type: "share_onboarding_cancelled",
          table_name: "share_onboarding_requests", record_id: row.id, reason: body.reason }),
      ]);
      return json({ ok: true });
    }

    if (row.status !== "submitted") return json({ error: "The shareholder has not signed yet, or this is already completed" }, 400);
    const amount = Number(row.amount);
    const shares = Number(row.shares);

    const [committed, { data: availRaw, error: availErr }] = await Promise.all([
      sharesCommitted(admin, row.id),
      admin.rpc("get_user_available_balance", { p_user_id: row.shareholder_id }),
    ]);
    if (availErr) throw availErr;
    if (committed + shares > ANGEL_TOTAL_SHARES) return json({ error: "Not enough shares left in the pool" }, 400);
    const available = Number(availRaw ?? 0);
    if (available < amount) {
      return json({ error: `The shareholder's wallet has UGX ${available.toLocaleString()} available; UGX ${amount.toLocaleString()} is needed.` }, 400);
    }

    const { data: wallet } = await admin.from("wallets").select("id").eq("user_id", row.shareholder_id).maybeSingle();
    if (!wallet) return json({ error: "The shareholder has no wallet yet" }, 400);

    const txDate = new Date().toISOString();
    const leg = (scope: string, direction: string, description: string) => ({
      user_id: row.shareholder_id, ledger_scope: scope, direction, amount, category: "share_capital",
      source_table: "angel_pool_investments", source_id: wallet.id, description, currency: "UGX",
      reference_id: row.reference_id, transaction_date: txDate,
    });
    const { data: groupId, error: rpcErr } = await admin.rpc("create_ledger_transaction", {
      entries: [
        leg("wallet", "cash_out", `Angel Pool shares: ${shares} shares @ UGX ${ANGEL_PRICE_PER_SHARE.toLocaleString()}/share`),
        leg("platform", "cash_in", "Angel Pool share capital received"),
      ],
      idempotency_key: `share-onboarding-${row.id}`,
    });
    if (rpcErr) {
      if (/insufficient/i.test(rpcErr.message ?? "")) return json({ error: "Insufficient wallet balance. Refresh and try again." }, 400);
      throw rpcErr;
    }

    const { data: inv, error: invErr } = await admin.from("angel_pool_investments").insert({
      investor_id: row.shareholder_id, amount, shares,
      pool_ownership_percent: row.pool_ownership_percent, company_ownership_percent: row.company_ownership_percent,
      status: "confirmed", reference_id: row.reference_id, funded_by: "investor", payment_method: "wallet",
      transaction_group_id: typeof groupId === "string" ? groupId : null,
    }).select("id").single();
    if (invErr) throw invErr;

    const pdfPath = `share-agreements/${row.id}.pdf`;
    const { error: upErr } = await admin.storage.from("partner-agreements")
      .upload(pdfPath, b64ToBytes(body.pdfBase64), { contentType: "application/pdf", upsert: true });
    if (upErr) console.error("share pdf upload failed", upErr);

    await admin.from("share_onboarding_requests").update({
      status: "completed", company_rep_name: body.repName, company_rep_position: body.repPosition,
      company_rep_signature_data_url: body.repSignature, company_signed_at: txDate, countersigned_by: user.id,
      pdf_path: upErr ? null : pdfPath, angel_pool_investment_id: inv.id,
    }).eq("id", row.id).eq("status", "submitted");

    // Final email with the signed agreement attached (BCC partnership@ is automatic for this template).
    let emailed = false;
    const { data: prof } = await admin.from("profiles").select("full_name, email").eq("id", row.shareholder_id).maybeSingle();
    if (prof?.email) {
      const { data: signed } = upErr ? { data: null } :
        await admin.storage.from("partner-agreements").createSignedUrl(pdfPath, 60 * 60 * 24 * 30);
      const sold = await sharesCommitted(admin);
      const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "angel-pool-share-purchase",
          recipientEmail: prof.email,
          idempotencyKey: `share-onboarding-final-${row.id}`,
          templateData: {
            partner_name: row.shareholder_name || prof.full_name || "Partner",
            pool_name: "Welile Early Angel Pool",
            share_reference: row.reference_id,
            shares_purchased: shares,
            currency: "UGX",
            investment_amount: amount,
            ownership_percentage: Number(row.company_ownership_percent).toFixed(4),
            price_per_share: ANGEL_PRICE_PER_SHARE,
            pool_valuation: ANGEL_TOTAL_SHARES * ANGEL_PRICE_PER_SHARE,
            purchase_date: formatAllocationDate(txDate),
            total_pool_shares: ANGEL_TOTAL_SHARES,
            available_shares: Math.max(0, ANGEL_TOTAL_SHARES - sold),
            pool_percentage: ANGEL_POOL_PERCENT,
            pool_round: "Seed Round",
            company_name: "Welile",
            funded_by: "investor",
            ...(signed?.signedUrl ? { agreement_url: signed.signedUrl } : {}),
            ...(upErr ? {} : { contract_pdf_path: pdfPath, contract_pdf_name: `Welile-Angel-Pool-Agreement-${row.reference_id}.pdf` }),
          },
        },
      });
      if (mailErr) console.error("share final email failed", mailErr); else emailed = true;
    }

    await Promise.all([
      logSystemEvent(admin, "account_activated", row.shareholder_id, "angel_pool_investments", inv.id,
        { action: "share_onboarding.completed", reference_id: row.reference_id, request_id: row.id, shares, amount, countersigned_by: user.id }),
      admin.from("audit_logs").insert({
        user_id: user.id, action_type: "share_onboarding_completed", table_name: "share_onboarding_requests",
        record_id: row.id, reason: `Shares countersigned and wallet debited (${row.reference_id})`,
        metadata: { amount, shares, investment_id: inv.id },
      }),
    ]);

    return json({ ok: true, emailed, pdf_path: upErr ? null : pdfPath });
  } catch (e) {
    console.error("[finalize-share-onboarding]", (e as Error)?.message || e);
    return json({ error: "Could not complete. Please try again." }, 500);
  }
});
