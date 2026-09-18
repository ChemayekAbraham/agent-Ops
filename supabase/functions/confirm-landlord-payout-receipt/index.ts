// Agent-facing landlord receipt confirmation.
//
// The agent is shown every landlord payout of theirs that is still waiting for
// the receipt the landlord got by SMS. They type that receipt number; we match
// it against the receipt actually issued for THAT payout and, only on a match,
// file the payout as completed.
//
// Money safety: the allocation was already applied earlier in the payout
// lifecycle (`allocation_applied_id` is set by
// `apply_landlord_payout_to_allocation`, which is idempotent), so flipping the
// status here cannot move float a second time. No wallet or ledger write
// happens in this function.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/** Receipt numbers are compared case- and separator-insensitively. */
const norm = (v: string) => v.trim().toUpperCase().replace(/[\s_]/g, "");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const auth = req.headers.get("Authorization");
    if (!auth) return json({ error: "Missing authorization" }, 401);
    const { data: u, error: uErr } = await admin.auth.getUser(auth.replace("Bearer ", ""));
    if (uErr || !u?.user) return json({ error: "Invalid token" }, 401);
    const agentId = u.user.id;

    const body = (await req.json().catch(() => ({}))) ?? {};
    const payoutId = typeof body.payout_id === "string" ? body.payout_id : null;
    const entered = typeof body.receipt_number === "string" ? body.receipt_number : "";

    if (!payoutId) return json({ error: "payout_id required" }, 400);
    if (norm(entered).length < 4) {
      return json({ error: "Enter at least 4 characters of the receipt number." }, 400);
    }

    const { data: payout, error: pErr } = await admin
      .from("landlord_payouts")
      .select("id, agent_id, status, amount, landlord_name, receipt_number, allocation_applied_id")
      .eq("id", payoutId)
      .maybeSingle();
    if (pErr || !payout) return json({ error: "Payout not found" }, 404);
    if (payout.agent_id !== agentId) return json({ error: "Forbidden" }, 403);

    // Already filed — treat as success so a double tap never looks like a failure.
    if (payout.status === "completed" && payout.receipt_number) {
      return json({ ok: true, already_confirmed: true, receipt_number: payout.receipt_number });
    }
    if (payout.status !== "awaiting_agent_receipt") {
      return json(
        { error: `This payment is '${payout.status}' — it is not waiting for a receipt.` },
        400,
      );
    }

    const { data: receipts, error: rErr } = await admin
      .from("landlord_payout_receipts")
      .select("id, receipt_number, receipt_code, short_link_code, status, reversed_at")
      .eq("payout_id", payoutId);
    if (rErr) return json({ error: rErr.message }, 400);

    const target = norm(entered);
    const match = (receipts ?? []).find(
      (r) =>
        !r.reversed_at &&
        [r.receipt_number, r.receipt_code, r.short_link_code]
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .some((v) => norm(v) === target),
    );

    if (!match) {
      return json({
        ok: true,
        matched: false,
        message: "That number does not match the receipt for this landlord payment.",
      });
    }

    const { error: updErr } = await admin
      .from("landlord_payouts")
      .update({
        status: "completed",
        receipt_number: match.receipt_number ?? entered.trim().toUpperCase(),
        receipt_uploaded_at: new Date().toISOString(),
      })
      .eq("id", payoutId)
      .eq("status", "awaiting_agent_receipt");
    if (updErr) return json({ error: updErr.message }, 400);

    await logSystemEvent(
      admin,
      "landlord_payout_receipt_uploaded",
      agentId,
      "landlord_payout",
      payoutId,
      {
        amount: payout.amount,
        landlord_name: payout.landlord_name,
        receipt_number: match.receipt_number,
        confirmed_by: "agent_receipt_number_entry",
      },
    ).catch(() => {});

    return json({ ok: true, matched: true, receipt_number: match.receipt_number });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
