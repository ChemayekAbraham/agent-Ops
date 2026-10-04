// Controlled settlement-replay entry point (Phase 1).
//
// Finishes the MISSING FINANCIAL SETTLEMENT of payouts that already happened in
// the real world. It never initiates a payout, never mints a TID, never sends a
// telecom instruction and never debits a customer wallet on its own — all of
// that is enforced inside `replay_withdrawal_settlement`.
//
// Actions: "classify" (read-only), "attach_evidence", "replay" (dry_run first).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  try {
    const body = await req.json().catch(() => ({}));
    const action = String((body as any)?.action ?? "classify");
    const withdrawalIds: string[] = Array.isArray((body as any)?.withdrawal_ids)
      ? (body as any).withdrawal_ids.map(String)
      : (body as any)?.withdrawal_id
      ? [String((body as any).withdrawal_id)]
      : [];

    if (withdrawalIds.length === 0) {
      return json({ error: "withdrawal_id (or withdrawal_ids) is required" }, 400);
    }
    // Controlled batch only — never an uncontrolled sweep.
    if (withdrawalIds.length > 10) {
      return json({ error: "at most 10 withdrawals per call" }, 400);
    }

    // ── Actor check ────────────────────────────────────────────────────────
    // A signed-in CFO / Financial Ops / manager / super admin, or a trusted
    // server-side call made with the service-role key (no user JWT).
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const isSystemCall = token === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    let actorId: string | null = null;

    if (!isSystemCall) {
      if (!token) return json({ error: "Missing authorization" }, 401);
      const { data: userData, error: userErr } = await admin.auth.getUser(token);
      if (userErr || !userData?.user) return json({ error: "Invalid token" }, 401);
      actorId = userData.user.id;
      const { data: roles } = await admin
        .from("user_roles")
        .select("role")
        .eq("user_id", actorId);
      const allowed = new Set(["cfo", "financial_ops", "manager", "super_admin"]);
      if (!(roles ?? []).some((r: { role: string }) => allowed.has(r.role))) {
        return json({ error: "Not authorized for settlement replay" }, 403);
      }
    }

    const results: unknown[] = [];

    for (const id of withdrawalIds) {
      if (action === "classify") {
        const { data, error } = await admin.rpc("classify_stranded_withdrawal", {
          p_withdrawal_id: id,
        });
        results.push(error ? { withdrawal_id: id, error: error.message } : data);
        continue;
      }

      if (action === "attach_evidence") {
        const { data, error } = await admin.rpc(
          "attach_withdrawal_payment_evidence",
          {
            p_withdrawal_id: id,
            p_evidence_source: String((body as any)?.evidence_source ?? ""),
            p_evidence_note: String((body as any)?.evidence_note ?? ""),
            p_transaction_id: (body as any)?.transaction_id ?? null,
            p_raw_sms: (body as any)?.raw_sms ?? null,
            p_amount_confirmed: (body as any)?.amount_confirmed ?? null,
          },
        );
        results.push(error ? { withdrawal_id: id, error: error.message } : data);
        continue;
      }

      if (action === "replay") {
        const dryRun = (body as any)?.dry_run !== false; // default: preview
        const { data, error } = await admin.rpc("replay_withdrawal_settlement", {
          p_withdrawal_id: id,
          p_dry_run: dryRun,
          p_reason: (body as any)?.reason ?? null,
          p_approve_customer_wallet_debit:
            (body as any)?.approve_customer_wallet_debit === true,
        });
        // Failures are already written to `withdrawal_settlement_replay_audit`
        // by the RPC; surface them here too so nothing is silent.
        results.push(
          error
            ? { withdrawal_id: id, ok: false, error: error.message }
            : data,
        );
        continue;
      }

      results.push({ withdrawal_id: id, error: `unknown action: ${action}` });
    }

    return json({ action, actor: actorId, system_call: isSystemCall, results });
  } catch (e) {
    console.error("[settlement-replay] fatal:", (e as Error).message);
    return json({ error: (e as Error).message }, 500);
  }
});
