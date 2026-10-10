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
import { planRepayment, repaymentLegs, splitColumns, FLOAT_LOAN_MAX_UGX, FLOAT_LOAN_DAILY_MAX_UGX } from "./floatSplit.ts";

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
      if (!loan) return json({ error: "Not found" }, 404);
      // Borrower pays themselves, or the loan's own lending agent collects from the borrower's wallet.
      const byAgent = loan.lender_agent_id === userId && loan.borrower_user_id !== userId;
      if (loan.borrower_user_id !== userId && !byAgent) return json({ error: "Not found" }, 404);
      if (!loan.borrower_user_id) return json({ error: "This borrower has no Welile wallet" }, 400);
      const payerId: string = loan.borrower_user_id;
      if (!["active", "partially_repaid"].includes(loan.status)) return json({ error: "Nothing left to pay" }, 400);

      const outstanding = outstandingOf(loan);
      if (amount > outstanding) return json({ error: `${byAgent ? "They" : "You"} only owe UGX ${outstanding.toLocaleString("en-US")}` }, 400);

      const plan = await planRepayment(admin, loan, amount);
      if (plan.amount < amount) {
        const msg = loan.funding_source === "float"
          ? `Not enough money in ${byAgent ? "the borrower's" : "your"} wallet. Up to UGX ${plan.amount.toLocaleString("en-US")} can be paid now (interest must come from the main wallet).`
          : `Not enough money in ${byAgent ? "the borrower's" : "your"} wallet. ${byAgent ? "They have" : "You have"} UGX ${plan.available.withdrawable.toLocaleString("en-US")}`;
        return json({ error: msg }, 400);
      }

      await admin.from("wallets").upsert(
        { user_id: loan.lender_agent_id, balance: 0 },
        { onConflict: "user_id", ignoreDuplicates: true },
      );

      const ref = `LBP-${loan.id.slice(0, 8)}-${requestId}`;
      const borrowerLabel = loan.borrower_display_name || loan.borrower_ai_id || "Borrower";
      const now = new Date().toISOString();
      const { error: ledgerError } = await admin.rpc("create_ledger_transaction", {
        entries: repaymentLegs(loan, plan, { ref, now, borrowerDesc: "Repayment to lending agent", lenderDesc: `Advance repayment from ${borrowerLabel}`, borrowerLabel }),
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
        ...splitColumns(loan, plan),
        last_repayment_at: now,
        status: fully ? "repaid" : "partially_repaid",
        closed_at: fully ? now : null,
        next_deduction_date: nextDate,
      }).eq("id", loan.id);

      await admin.from("lending_audit_log").insert({
        actor_id: userId, actor_display_name: byAgent ? "Lending agent" : borrowerLabel, action_type: "repayment_recorded",
        entity_type: "loan", entity_id: loan.id, borrower_user_id: payerId,
        lender_agent_id: loan.lender_agent_id, amount_ugx: amount,
        new_status: fully ? "repaid" : "partially_repaid",
        details: { borrower_paid: !byAgent, agent_collected: byAgent, reference: ref, total_repaid_ugx: newRepaid },
      }).then(() => {}, () => {});

      await admin.from("system_events").insert({
        event_type: "payment_made", user_id: payerId, related_entity_type: "lending_agent_loan",
        related_entity_id: loan.id, metadata: { amount, reference: ref, by: byAgent ? "lending_agent" : "borrower" },
      }).then(() => {}, () => {});
      try { await admin.rpc("recompute_trust_score", { p_user_id: payerId }); } catch (_) { /* best effort */ }

      const { data: after } = await admin.rpc("get_user_available_balance", { p_user_id: payerId });
      return json({ ok: true, reference: ref, borrower_wallet_after_ugx: Math.max(0, Math.floor(Number(after ?? 0))), paid_ugx: amount, remaining_ugx: Math.max(0, outstanding - amount), fully_repaid: fully });
    }

    // Lending agent tops up (adds money to) and/or renews an existing loan.
    // Money moves lender → borrower FIRST; the loan only changes if that succeeds.
    if (action === "disburse") {
      // New loan funded from the lender's OPERATIONAL FLOAT into the borrower's float.
      // Money moves first; the loan row only exists if the transfer succeeded.
      const requestId = String(body?.request_id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
      const borrowerId = String(body?.borrower_user_id || "");
      const principal = Math.floor(Number(body?.principal) || 0);
      const rate = Math.max(0, Math.min(100, Number(body?.interest_rate_pct) || 0));
      const due = String(body?.due_date || "").slice(0, 10);
      const freq = ["daily", "weekly", "monthly", "once", "end_of_month"].includes(body?.frequency) ? body.frequency : "monthly";
      const installment = Math.max(0, Math.round(Number(body?.installment) || 0));
      const firstDate = String(body?.first_date || "").slice(0, 10) || null;
      const loanRequestId = body?.loan_request_id ? String(body.loan_request_id) : null;
      if (!requestId || !borrowerId || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return json({ error: "Missing details" }, 400);
      if (borrowerId === userId) return json({ error: "You cannot lend to yourself" }, 400);
      if (principal < 1000) return json({ error: "Minimum loan is UGX 1,000" }, 400);
      if (principal > FLOAT_LOAN_MAX_UGX) return json({ error: `Maximum per loan is UGX ${FLOAT_LOAN_MAX_UGX.toLocaleString("en-US")}` }, 400);
      if (due <= new Date().toISOString().slice(0, 10)) return json({ error: "Pick a due date after today" }, 400);
      const ref = `LFD-${requestId}`;
      const { data: dup } = await admin.from("lending_agent_loans").select("id").eq("disbursement_reference", ref).maybeSingle();
      if (dup) return json({ ok: true, loan_id: dup.id, reference: ref, replay: true });
      const { data: agreement } = await admin.from("lending_agent_agreement_acceptance").select("id").eq("agent_user_id", userId).limit(1).maybeSingle();
      if (agreement === null) return json({ error: "Sign the lending agreement first" }, 403);
      const since = new Date(Date.now() - 86400000).toISOString();
      const { data: todays } = await admin.from("lending_agent_loans").select("principal_ugx").eq("lender_agent_id", userId).eq("funding_source", "float").gte("created_at", since);
      const lentToday = (todays ?? []).reduce((a: number, r: any) => a + (Number(r.principal_ugx) || 0), 0);
      if (lentToday + principal > FLOAT_LOAN_DAILY_MAX_UGX) return json({ error: `Daily float lending limit is UGX ${FLOAT_LOAN_DAILY_MAX_UGX.toLocaleString("en-US")}. You can lend UGX ${Math.max(0, FLOAT_LOAN_DAILY_MAX_UGX - lentToday).toLocaleString("en-US")} more today.` }, 400);
      const { data: fRaw, error: fErr } = await admin.rpc("get_user_float_available_balance", { p_user_id: userId });
      if (fErr) throw fErr;
      const floatAvail = Math.max(0, Math.floor(Number(fRaw ?? 0)));
      if (principal > floatAvail) return json({ error: `Not enough operational float. You have UGX ${floatAvail.toLocaleString("en-US")}` }, 400);
      const [{ data: bp }, { data: lp }] = await Promise.all([
        admin.from("profiles").select("full_name, phone").eq("id", borrowerId).maybeSingle(),
        admin.from("profiles").select("full_name").eq("id", userId).maybeSingle(),
      ]);
      if (!bp) return json({ error: "Borrower not found" }, 404);
      const borrowerLabel = bp.full_name || "Borrower";
      const lenderLabel = lp?.full_name || "Lending agent";
      const loanId = crypto.randomUUID();
      const now = new Date().toISOString();
      await admin.from("wallets").upsert({ user_id: borrowerId, balance: 0 }, { onConflict: "user_id", ignoreDuplicates: true });
      const base = { amount: principal, category: "wallet_transfer", ledger_scope: "wallet", source_table: "lending_agent_loans", source_id: loanId, currency: "UGX", transaction_date: now, reference_id: ref, recipient_type: "operational_wallet" };
      const { error: lErr } = await admin.rpc("create_ledger_transaction", {
        entries: [
          { ...base, user_id: userId, direction: "cash_out", description: `Float loan to ${borrowerLabel} float_usage=lending_float_loan`, linked_party: borrowerLabel },
          { ...base, user_id: borrowerId, direction: "cash_in", description: `Float loan from ${lenderLabel} float_usage=lending_float_loan`, linked_party: lenderLabel },
        ],
        idempotency_key: ref,
      });
      if (lErr) { console.error("[lending-borrower-pay] disburse ledger", lErr); return json({ error: "Loan failed. No float was sent." }, 400); }
      const { error: insErr } = await admin.from("lending_agent_loans").insert({
        id: loanId, lender_agent_id: userId, borrower_user_id: borrowerId,
        borrower_ai_id: body?.borrower_ai_id ? String(body.borrower_ai_id).slice(0, 40) : null,
        borrower_display_name: bp.full_name, borrower_phone: bp.phone,
        principal_ugx: principal, interest_rate_pct: rate, expected_repayment_date: due,
        loan_purpose: body?.purpose ? String(body.purpose).slice(0, 300) : null, platform_fee_ugx: 0,
        status: "active", repayment_frequency: freq, auto_deduct_enabled: true,
        installment_ugx: installment || null, next_deduction_date: firstDate, auto_deduct_started_at: now,
        funding_source: "float", disbursement_reference: ref,
      });
      if (insErr) { console.error("[lending-borrower-pay] disburse insert", insErr, { ref }); return json({ error: `Float was sent (ref ${ref}) but the loan could not be saved. Contact support.` }, 500); }
      if (loanRequestId) await admin.from("lending_loan_requests").update({ status: "approved", decided_at: now, loan_id: loanId }).eq("id", loanRequestId).eq("lender_agent_id", userId).then(() => {}, () => {});
      await admin.from("lending_audit_log").insert({ actor_id: userId, actor_display_name: lenderLabel, action_type: "loan_disbursed", entity_type: "loan", entity_id: loanId, borrower_user_id: borrowerId, lender_agent_id: userId, amount_ugx: principal, fee_ugx: 0, new_status: "active", details: { funding_source: "float", reference: ref, interest_rate_pct: rate } }).then(() => {}, () => {});
      await admin.from("system_events").insert({ event_type: "wallet_transfer", user_id: borrowerId, related_entity_type: "lending_agent_loan", related_entity_id: loanId, metadata: { amount: principal, reference: ref, kind: "float_loan" } }).then(() => {}, () => {});
      return json({ ok: true, loan_id: loanId, reference: ref, total_owed_ugx: Math.round(principal * (1 + rate / 100)) });
    }

    if (action === "recovery") {
      // Lender flags (or un-flags) an overdue loan as "in recovery". No money moves.
      const loanId = String(body?.loan_id || "");
      const on = body?.on !== false;
      if (!loanId) return json({ error: "Missing details" }, 400);
      const { data: loan } = await admin.from("lending_agent_loans").select("*").eq("id", loanId).maybeSingle();
      if (!loan || loan.lender_agent_id !== userId) return json({ error: "Not found" }, 404);
      if (!["active", "partially_repaid"].includes(loan.status)) return json({ error: "Only open loans can be put in recovery" }, 400);
      if (on) {
        const due = loan.expected_repayment_date ? new Date(loan.expected_repayment_date).getTime() : null;
        if (due === null || due >= new Date().setHours(0, 0, 0, 0)) return json({ error: "Only overdue loans can be put in recovery" }, 400);
      }
      const { error: updError } = await admin.from("lending_agent_loans").update({ recovery_started_at: on ? new Date().toISOString() : null }).eq("id", loan.id);
      if (updError) return json({ error: "Could not update the loan" }, 500);
      await admin.from("lending_audit_log").insert({ actor_id: userId, actor_display_name: "Lending agent", action_type: "status_change", entity_type: "loan", entity_id: loan.id, borrower_user_id: loan.borrower_user_id, lender_agent_id: userId, amount_ugx: 0, fee_ugx: 0, old_status: loan.status, new_status: loan.status, details: { kind: on ? "recovery_started" : "recovery_cleared", money_sent: false } });
      return json({ ok: true, in_recovery: on });
    }

    if (action === "topup") {
      const loanId = String(body?.loan_id || "");
      const requestId = String(body?.request_id || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 36);
      const extra = Math.floor(Number(body?.extra) || 0);
      const fee = Math.max(0, Math.round(Number(body?.fee) || 0));
      const newDue = String(body?.new_due || "").slice(0, 10);
      const installment = Math.max(0, Math.round(Number(body?.installment) || 0));
      const firstDate = String(body?.first_date || "").slice(0, 10) || null;
      if (!loanId || !requestId || !/^\d{4}-\d{2}-\d{2}$/.test(newDue)) return json({ error: "Missing details" }, 400);
      if (extra < 0 || extra > 100_000_000) return json({ error: "Invalid amount" }, 400);
      if (extra > 0 && extra < 1000) return json({ error: "Minimum top-up is UGX 1,000" }, 400);

      const { data: loan } = await admin.from("lending_agent_loans").select("*").eq("id", loanId).maybeSingle();
      if (!loan || loan.lender_agent_id !== userId) return json({ error: "Not found" }, 404);
      if (extra > 0 && !loan.borrower_user_id) return json({ error: "This borrower has no Welile wallet" }, 400);
      if (["cancelled", "defaulted", "written_off"].includes(loan.status)) return json({ error: "This loan is closed" }, 400);

      const ref = `LTU-${loan.id.slice(0, 8)}-${requestId}`;
      const borrowerLabel = loan.borrower_display_name || loan.borrower_ai_id || "Borrower";
      const now = new Date().toISOString();

      if (extra > 0) {
        const isFloat = loan.funding_source === "float";
        if (isFloat && extra > FLOAT_LOAN_MAX_UGX) return json({ error: `Maximum float top-up is UGX ${FLOAT_LOAN_MAX_UGX.toLocaleString("en-US")}` }, 400);
        const { data: availRaw, error: availError } = await admin.rpc(isFloat ? "get_user_float_available_balance" : "get_user_available_balance", { p_user_id: userId });
        if (availError) throw availError;
        const available = Math.max(0, Math.floor(Number(availRaw ?? 0)));
        if (extra > available) {
          return json({ error: `Not enough ${isFloat ? "operational float" : "money in your wallet"}. You have UGX ${available.toLocaleString("en-US")}` }, 400);
        }
        await admin.from("wallets").upsert(
          { user_id: loan.borrower_user_id, balance: 0 },
          { onConflict: "user_id", ignoreDuplicates: true },
        );
        const { data: lender } = await admin.from("profiles").select("full_name").eq("id", userId).maybeSingle();
        const lenderLabel = lender?.full_name || "Lending agent";
        const { error: ledgerError } = await admin.rpc("create_ledger_transaction", {
          entries: [
            {
              user_id: userId, amount: extra, direction: "cash_out", category: "wallet_transfer",
              ledger_scope: "wallet", source_table: "lending_agent_loans", source_id: loan.id,
              description: `Loan top-up to ${borrowerLabel}`, currency: "UGX", transaction_date: now,
              reference_id: ref, linked_party: borrowerLabel, recipient_type: loan.funding_source === "float" ? "operational_wallet" : "user",
            },
            {
              user_id: loan.borrower_user_id, amount: extra, direction: "cash_in", category: "wallet_transfer",
              ledger_scope: "wallet", source_table: "lending_agent_loans", source_id: loan.id,
              description: `Loan top-up from ${lenderLabel}`, currency: "UGX", transaction_date: now,
              reference_id: ref, linked_party: lenderLabel, recipient_type: loan.funding_source === "float" ? "operational_wallet" : "user",
            },
          ],
          idempotency_key: ref,
        });
        if (ledgerError) {
          console.error("[lending-borrower-pay] topup ledger", ledgerError);
          return json({ error: "Top-up failed. No money was sent and the loan was not changed." }, 400);
        }
      }

      const newPrincipal = (Number(loan.principal_ugx) || 0) + extra;
      const repaid = Number(loan.amount_repaid_ugx) || 0;
      const freq = loan.repayment_frequency === "once" ? "monthly" : (loan.repayment_frequency || "monthly");
      const { error: updError } = await admin.from("lending_agent_loans").update({
        principal_ugx: newPrincipal,
        platform_fee_ugx: (Number(loan.platform_fee_ugx) || 0) + (extra > 0 ? fee : 0),
        expected_repayment_date: newDue,
        status: repaid > 0 ? "partially_repaid" : "active",
        closed_at: null,
        auto_deduct_enabled: true,
        repayment_frequency: freq,
        installment_ugx: installment || null,
        next_deduction_date: firstDate,
      }).eq("id", loan.id);
      if (updError) {
        console.error("[lending-borrower-pay] topup update", updError, { ref });
        return json({ error: `Money was sent (ref ${ref}) but the loan could not be updated. Contact support.` }, 500);
      }

      await admin.from("lending_audit_log").insert({
        actor_id: userId, actor_display_name: "Lending agent", action_type: "status_change",
        entity_type: "loan", entity_id: loan.id, borrower_user_id: loan.borrower_user_id,
        lender_agent_id: userId, amount_ugx: extra, fee_ugx: extra > 0 ? fee : 0,
        old_status: loan.status, new_status: repaid > 0 ? "partially_repaid" : "active",
        details: {
          kind: extra > 0 ? "topup" : "renew", reference: extra > 0 ? ref : null, money_sent: extra > 0,
          old_principal_ugx: loan.principal_ugx, new_principal_ugx: newPrincipal,
          old_due: loan.expected_repayment_date, new_due: newDue,
        },
      }).then(() => {}, () => {});
      if (extra > 0) {
        await admin.from("system_events").insert({
          event_type: "wallet_transfer", user_id: loan.borrower_user_id, related_entity_type: "lending_agent_loan",
          related_entity_id: loan.id, metadata: { amount: extra, reference: ref, kind: "loan_topup" },
        }).then(() => {}, () => {});
      }
      const remaining = Math.max(0, Math.round(newPrincipal * (1 + (Number(loan.interest_rate_pct) || 0) / 100) - repaid));
      return json({ ok: true, reference: extra > 0 ? ref : null, remaining_ugx: remaining });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[lending-borrower-pay] error", err);
    return json({ error: "Something went wrong. Try again." }, 500);
  }
});
