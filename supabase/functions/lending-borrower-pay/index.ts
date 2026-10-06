// Borrower-facing repayment for lending-agent advances.
// action "list": the signed-in borrower's advances, each with its installment
//   schedule (amount + due date + paid state) and payment history.
// action "pay": moves { amount } from the borrower's strict available wallet
//   balance to the lending agent via create_ledger_transaction (single writer).
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  firstDeductionDate,
  nextDeductionDate,
  scheduledDatesThrough,
  unpaidScheduledDates,
  ymd,
  type Frequency,
} from "./schedule.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function totalOwedOf(loan: any): number {
  const p = Number(loan.principal_ugx) || 0;
  return Math.round(p + (p * (Number(loan.interest_rate_pct) || 0)) / 100);
}

function outstandingOf(loan: any): number {
  return Math.max(0, totalOwedOf(loan) - (Number(loan.amount_repaid_ugx) || 0));
}

/** Full schedule to the end date, with each installment's paid state. */
function buildSchedule(loan: any) {
  const freq = (loan.repayment_frequency as Frequency) || "once";
  const totalOwed = totalOwedOf(loan);
  const installment = Math.max(0, Math.round(Number(loan.installment_ugx) || 0)) || totalOwed;
  const first = firstDeductionDate(
    loan.auto_deduct_started_at || loan.created_at,
    loan.expected_repayment_date,
    freq,
  );
  const end = loan.expected_repayment_date || first;
  let dates = scheduledDatesThrough(first, end > first ? end : first, loan.expected_repayment_date, freq);
  if (dates.length === 0) dates = [first];
  let paidLeft = Number(loan.amount_repaid_ugx) || 0;
  let remaining = totalOwed;
  const today = ymd(new Date());
  const rows: any[] = [];
  for (let i = 0; i < dates.length && remaining > 0; i++) {
    const isLast = i === dates.length - 1;
    const amount = isLast ? remaining : Math.min(installment, remaining);
    const paid = Math.min(amount, paidLeft);
    paidLeft -= paid;
    remaining -= amount;
    rows.push({
      due_date: dates[i],
      amount_ugx: amount,
      paid_ugx: paid,
      status: paid >= amount ? "paid" : dates[i] < today ? "overdue" : dates[i] === today ? "due_today" : paid > 0 ? "part_paid" : "upcoming",
    });
  }
  return rows;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    const { data: userData, error: authError } = await admin.auth.getUser(token);
    if (authError || !userData?.user) return json({ error: "Please sign in again" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const action = body?.action || "list";

    if (action === "list") {
      const { data: loans, error } = await admin
        .from("lending_agent_loans")
        .select("*")
        .eq("borrower_user_id", userId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const ids = (loans ?? []).map((l: any) => l.id);
      const lenderIds = [...new Set((loans ?? []).map((l: any) => l.lender_agent_id))];
      const [{ data: logs }, { data: lenders }] = await Promise.all([
        ids.length
          ? admin.from("lending_audit_log")
            .select("entity_id, amount_ugx, created_at, details")
            .in("entity_id", ids)
            .eq("action_type", "repayment_recorded")
            .order("created_at", { ascending: false })
          : Promise.resolve({ data: [] as any[] }),
        lenderIds.length
          ? admin.from("profiles").select("id, full_name").in("id", lenderIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const { data: avail } = await admin.rpc("get_user_available_balance", { p_user_id: userId });
      const lenderName = new Map((lenders ?? []).map((p: any) => [p.id, p.full_name]));
      return json({
        available_ugx: Math.max(0, Math.floor(Number(avail ?? 0))),
        loans: (loans ?? []).map((l: any) => ({
          id: l.id,
          lender_name: lenderName.get(l.lender_agent_id) ?? "Lending agent",
          principal_ugx: Number(l.principal_ugx),
          total_owed_ugx: totalOwedOf(l),
          repaid_ugx: Number(l.amount_repaid_ugx) || 0,
          outstanding_ugx: outstandingOf(l),
          status: l.status,
          end_date: l.expected_repayment_date,
          frequency: l.repayment_frequency,
          schedule: buildSchedule(l),
          payments: (logs ?? [])
            .filter((g: any) => g.entity_id === l.id)
            .map((g: any) => ({
              amount_ugx: Number(g.amount_ugx) || 0,
              paid_at: g.created_at,
              method: g.details?.auto ? "auto" : g.details?.borrower_paid ? "you" : "agent",
            })),
        })),
      });
    }

    if (action === "pay") {
      const loanId = String(body?.loan_id || "");
      const requestId = String(body?.request_id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
      const amount = Math.floor(Number(body?.amount) || 0);
      if (!loanId || !requestId) return json({ error: "Missing details" }, 400);
      if (amount < 500) return json({ error: "Minimum payment is UGX 500" }, 400);

      const { data: loan } = await admin.from("lending_agent_loans").select("*").eq("id", loanId).maybeSingle();
      if (!loan || loan.borrower_user_id !== userId) return json({ error: "Not found" }, 404);
      if (!["active", "partially_repaid"].includes(loan.status)) return json({ error: "Nothing left to pay" }, 400);

      const outstanding = outstandingOf(loan);
      if (amount > outstanding) return json({ error: `You only owe UGX ${outstanding.toLocaleString("en-US")}` }, 400);

      const { data: availRaw, error: availError } = await admin.rpc("get_user_available_balance", { p_user_id: userId });
      if (availError) throw availError;
      const available = Math.max(0, Math.floor(Number(availRaw ?? 0)));
      if (amount > available) {
        return json({ error: `Not enough money in your wallet. You have UGX ${available.toLocaleString("en-US")}` }, 400);
      }

      await admin.from("wallets").upsert(
        { user_id: loan.lender_agent_id, balance: 0 },
        { onConflict: "user_id", ignoreDuplicates: true },
      );

      const ref = `LBP-${loan.id.slice(0, 8)}-${requestId}`;
      const borrowerLabel = loan.borrower_display_name || loan.borrower_ai_id || "Borrower";
      const now = new Date().toISOString();
      const { error: ledgerError } = await admin.rpc("create_ledger_transaction", {
        entries: [
          {
            user_id: userId, amount, direction: "cash_out", category: "wallet_transfer",
            ledger_scope: "wallet", source_table: "lending_agent_loans", source_id: loan.id,
            description: "Repayment to lending agent", currency: "UGX", transaction_date: now,
            reference_id: ref, linked_party: "Lending agent", recipient_type: "user",
          },
          {
            user_id: loan.lender_agent_id, amount, direction: "cash_in", category: "wallet_transfer",
            ledger_scope: "wallet", source_table: "lending_agent_loans", source_id: loan.id,
            description: `Advance repayment from ${borrowerLabel}`, currency: "UGX", transaction_date: now,
            reference_id: ref, linked_party: borrowerLabel, recipient_type: "user",
          },
        ],
        idempotency_key: ref,
      });
      if (ledgerError) {
        console.error("[lending-borrower-pay] ledger", ledgerError);
        return json({ error: "Payment failed. No money was taken." }, 400);
      }

      const newRepaid = (Number(loan.amount_repaid_ugx) || 0) + amount;
      const fully = newRepaid >= totalOwedOf(loan);
      const freq = (loan.repayment_frequency as Frequency) || "once";
      const today = ymd(new Date());
      const first = firstDeductionDate(loan.auto_deduct_started_at || loan.created_at, loan.expected_repayment_date, freq);
      const installment = Math.round(Number(loan.installment_ugx) || 0) || totalOwedOf(loan);
      const datesDue = scheduledDatesThrough(first, today, loan.expected_repayment_date, freq);
      const unpaid = unpaidScheduledDates(datesDue, installment, newRepaid, totalOwedOf(loan));
      const lastDue = datesDue.at(-1);
      const nextDate = fully ? null : unpaid[0] || (lastDue ? nextDeductionDate(lastDue, freq) : first);

      await admin.from("lending_agent_loans").update({
        amount_repaid_ugx: newRepaid,
        last_repayment_at: now,
        status: fully ? "repaid" : "partially_repaid",
        closed_at: fully ? now : null,
        next_deduction_date: nextDate,
      }).eq("id", loan.id);

      await admin.from("lending_audit_log").insert({
        actor_id: userId, actor_display_name: borrowerLabel, action_type: "repayment_recorded",
        entity_type: "loan", entity_id: loan.id, borrower_user_id: userId,
        lender_agent_id: loan.lender_agent_id, amount_ugx: amount,
        new_status: fully ? "repaid" : "partially_repaid",
        details: { borrower_paid: true, reference: ref, total_repaid_ugx: newRepaid },
      }).then(() => {}, () => {});

      await admin.from("system_events").insert({
        event_type: "payment_made", user_id: userId, related_entity_type: "lending_agent_loan",
        related_entity_id: loan.id, metadata: { amount, reference: ref, by: "borrower" },
      }).then(() => {}, () => {});
      try { await admin.rpc("recompute_trust_score", { p_user_id: userId }); } catch (_) { /* best effort */ }

      return json({ ok: true, paid_ugx: amount, remaining_ugx: Math.max(0, outstanding - amount), fully_repaid: fully });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[lending-borrower-pay] error", err);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
