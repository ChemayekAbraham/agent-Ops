// Lending Agent auto-deduction sweep.
// Pulls scheduled installments from each borrower's withdrawable wallet into
// the lending agent's wallet via the single-writer create_ledger_transaction
// RPC. Designed to run on a daily cron, but also accepts an optional
// { loan_id } body so an agent can trigger a single loan immediately to test.
import { createClient } from "npm:@supabase/supabase-js@2";
import { logSystemEvent } from "../_shared/eventLogger.ts";
import {
  firstDeductionDate,
  nextDeductionDate,
  overdueAmount,
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

function outstandingOf(loan: any): number {
  const interest =
    (Number(loan.principal_ugx) * (Number(loan.interest_rate_pct) || 0)) / 100;
  const owed =
    Number(loan.principal_ugx) + interest - (Number(loan.amount_repaid_ugx) || 0);
  return Math.max(0, Math.round(owed));
}

const EMAIL_OVERRIDES: Record<string, string> = {
  // Product-owner authorised 2026-09-24 for this borrowing identity only.
  "18d9fe76-9688-45b3-a468-fb77e3a8ab79": "kamulindecoseaenock@gmail.com",
};

function formatUGX(amount: number): string {
  return `UGX ${Math.max(0, Math.round(amount)).toLocaleString("en-US")}`;
}

async function notifyBorrower(
  admin: any,
  loan: any,
  today: string,
  status: "overdue" | "deducted",
  amount: number,
  remainingBalance: number,
  overdueDates: string[],
): Promise<void> {
  const eventKey = `lending-repayment-${status}-${loan.id}-${today}`;
  const dateText = overdueDates.length > 0 ? overdueDates.join(", ") : "none";
  const title = status === "deducted"
    ? `${formatUGX(amount)} repayment recovered`
    : "Repayment overdue — fund your wallet";
  const message = status === "deducted"
    ? `${formatUGX(amount)} was recovered from your available wallet balance. Remaining balance: ${formatUGX(remainingBalance)}. Overdue dates: ${dateText}. Consistent funded-wallet repayments can improve eligibility for future access up to UGX 30,000,000; eligibility is assessed and not guaranteed.`
    : `Keep money in your Welile wallet for automatic recovery. Overdue dates: ${dateText}. Consistent funded-wallet repayments can improve eligibility for future access up to UGX 30,000,000; eligibility is assessed and not guaranteed.`;

  try {
    const { data: existing } = await admin
      .from("notifications")
      .select("id")
      .eq("user_id", loan.borrower_user_id)
      .eq("event_key", eventKey)
      .maybeSingle();
    if (!existing) {
      await admin.from("notifications").insert({
        user_id: loan.borrower_user_id,
        title,
        message,
        type: status === "deducted" ? "success" : "warning",
        event_key: eventKey,
        metadata: {
          kind: "lending_repayment_status",
          loan_id: loan.id,
          status,
          amount_ugx: amount,
          remaining_balance_ugx: remainingBalance,
          overdue_dates: overdueDates,
        },
      });
    }
  } catch (error) {
    console.error("[lending-auto-deduct] notification failed", { loan_id: loan.id, error });
  }

  try {
    let recipientEmail = EMAIL_OVERRIDES[loan.borrower_user_id] ?? null;
    if (!recipientEmail) {
      const { data: profile } = await admin
        .from("profiles")
        .select("email")
        .eq("id", loan.borrower_user_id)
        .maybeSingle();
      recipientEmail = profile?.email ?? null;
    }
    if (recipientEmail) {
      const { error } = await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "lending-repayment-status",
          recipientEmail,
          idempotencyKey: eventKey,
          templateData: {
            borrowerName: loan.borrower_display_name || "there",
            status,
            amount,
            remainingBalance,
            overdueDates,
          },
        },
      });
      if (error) console.error("[lending-auto-deduct] email failed", { loan_id: loan.id, error });
    }
  } catch (error) {
    console.error("[lending-auto-deduct] email failed", { loan_id: loan.id, error });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json().catch(() => ({}));
    const singleLoanId: string | undefined = body?.loan_id;
    const today = ymd(new Date());

    // Fetch the loans due for an auto-deduction.
    let query = admin
      .from("lending_agent_loans")
      .select("*")
      .eq("auto_deduct_enabled", true)
      .in("status", ["active", "partially_repaid"])
      .not("borrower_user_id", "is", null);

    if (singleLoanId) {
      query = query.eq("id", singleLoanId);
    } else {
      query = query.lte("next_deduction_date", today);
    }

    const { data: loans, error: loansError } = await query.limit(500);
    if (loansError) throw loansError;

    const results: any[] = [];

    for (const loan of loans ?? []) {
      const freq = (loan.repayment_frequency as Frequency) || "once";
      const outstanding = outstandingOf(loan);
      const totalOwed = outstanding + (Number(loan.amount_repaid_ugx) || 0);

      // Already settled — close it out.
      if (outstanding <= 0) {
        await admin
          .from("lending_agent_loans")
          .update({
            status: "repaid",
            closed_at: new Date().toISOString(),
            next_deduction_date: null,
          })
          .eq("id", loan.id);
        results.push({ loan_id: loan.id, action: "closed_no_balance" });
        continue;
      }

      const installment = Math.max(0, Math.round(Number(loan.installment_ugx) || 0)) || totalOwed;
      const firstDate = firstDeductionDate(
        loan.auto_deduct_started_at || loan.created_at,
        loan.expected_repayment_date,
        freq,
      );
      const datesDue = scheduledDatesThrough(
        firstDate,
        today,
        loan.expected_repayment_date,
        freq,
      );
      const unpaidDatesBefore = unpaidScheduledDates(
        datesDue,
        installment,
        Number(loan.amount_repaid_ugx) || 0,
        totalOwed,
      );
      const overdueBefore = unpaidDatesBefore.filter((date) => date < today);
      const amountDue = overdueAmount(
        datesDue.length,
        installment,
        Number(loan.amount_repaid_ugx) || 0,
        totalOwed,
      );
      const target = Math.min(outstanding, amountDue);

      if (target <= 0) {
        const lastDue = datesDue.at(-1);
        const futureDate = lastDue
          ? nextDeductionDate(lastDue, freq)
          : firstDate;
        await admin.from("lending_agent_loans").update({
          next_deduction_date: futureDate,
        }).eq("id", loan.id);
        results.push({ loan_id: loan.id, action: "not_due", next_deduction_date: futureDate });
        continue;
      }

      // How much can we actually pull from the borrower's withdrawable wallet?
      const { data: availRaw, error: availError } = await admin.rpc(
        "get_user_available_balance",
        { p_user_id: loan.borrower_user_id },
      );
      if (availError) {
        results.push({ loan_id: loan.id, action: "balance_error", error: availError.message });
        continue;
      }
      const available = Math.max(0, Math.floor(Number(availRaw ?? 0)));
      const deductible = Math.min(target, available);

      const attempts = (Number(loan.auto_deduct_attempts) || 0) + 1;

      if (deductible <= 0) {
        // Preserve the oldest unpaid date. The arrears are not discarded when
        // an attempt finds an empty wallet; tomorrow's run retries them first.
        await admin
          .from("lending_agent_loans")
          .update({
            auto_deduct_attempts: attempts,
            next_deduction_date: unpaidDatesBefore[0] || loan.next_deduction_date,
          })
          .eq("id", loan.id);
        await notifyBorrower(admin, loan, today, "overdue", 0, outstanding, overdueBefore);
        await logSystemEvent(
          admin,
          "lending_repayment_overdue",
          loan.borrower_user_id,
          "lending_agent_loans",
          loan.id,
          { overdue_dates: overdueBefore, amount_due_ugx: target },
        );
        results.push({ loan_id: loan.id, action: "no_funds", available });
        continue;
      }

      // Ensure the lender wallet exists.
      await admin
        .from("wallets")
        .upsert(
          { user_id: loan.lender_agent_id, balance: 0 },
          { onConflict: "user_id", ignoreDuplicates: true },
        );

      const ref = `LAD-${loan.id.slice(0, 8)}-${today.replace(/-/g, "")}`;
      const lenderLabel = "lending advance";
      const borrowerLabel = loan.borrower_display_name || loan.borrower_ai_id || "Borrower";

      const { error: ledgerError } = await admin.rpc("create_ledger_transaction", {
        entries: [
          {
            user_id: loan.borrower_user_id,
            amount: deductible,
            direction: "cash_out",
            category: "wallet_transfer",
            ledger_scope: "wallet",
            source_table: "lending_agent_loans",
            source_id: loan.id,
            description: `Automatic repayment to ${lenderLabel}`,
            currency: "UGX",
            transaction_date: new Date().toISOString(),
            reference_id: ref,
            linked_party: "Lending agent",
            recipient_type: "user",
          },
          {
            user_id: loan.lender_agent_id,
            amount: deductible,
            direction: "cash_in",
            category: "wallet_transfer",
            ledger_scope: "wallet",
            source_table: "lending_agent_loans",
            source_id: loan.id,
            description: `Advance repayment from ${borrowerLabel}`,
            currency: "UGX",
            transaction_date: new Date().toISOString(),
            reference_id: ref,
            linked_party: borrowerLabel,
            recipient_type: "user",
          },
        ],
        idempotency_key: ref,
      });

      if (ledgerError) {
        await admin
          .from("lending_agent_loans")
          .update({ auto_deduct_attempts: attempts })
          .eq("id", loan.id);
        results.push({ loan_id: loan.id, action: "ledger_error", error: ledgerError.message });
        continue;
      }

      const newRepaid = (Number(loan.amount_repaid_ugx) || 0) + deductible;
      const newOutstanding = outstanding - deductible;
      const fullyRepaid = newOutstanding <= 0;
      const newStatus = fullyRepaid ? "repaid" : "partially_repaid";
      const unpaidDatesAfter = unpaidScheduledDates(
        datesDue,
        installment,
        newRepaid,
        totalOwed,
      );
      const overdueAfter = unpaidDatesAfter.filter((date) => date < today);
      const lastDue = datesDue.at(-1);
      const updatedNextDate = fullyRepaid
        ? null
        : unpaidDatesAfter[0] || (lastDue ? nextDeductionDate(lastDue, freq) : firstDate);

      await admin
        .from("lending_agent_loans")
        .update({
          amount_repaid_ugx: newRepaid,
          auto_deduct_collected_ugx:
            (Number(loan.auto_deduct_collected_ugx) || 0) + deductible,
          auto_deduct_attempts: attempts,
          last_repayment_at: new Date().toISOString(),
          last_auto_deduct_at: new Date().toISOString(),
          status: newStatus,
          closed_at: fullyRepaid ? new Date().toISOString() : null,
          next_deduction_date: updatedNextDate,
        })
        .eq("id", loan.id);

      // Audit + system event (best effort).
      await admin.from("lending_audit_log").insert({
        actor_id: loan.lender_agent_id,
        actor_display_name: "Auto-deduction",
        action_type: "repayment_recorded",
        entity_type: "loan",
        entity_id: loan.id,
        borrower_user_id: loan.borrower_user_id,
        lender_agent_id: loan.lender_agent_id,
        amount_ugx: deductible,
        new_status: newStatus,
        details: {
          auto: true,
          frequency: freq,
          reference: ref,
          partial: deductible < target,
          total_repaid_ugx: newRepaid,
        },
      }).then(() => {}, () => {});

      await logSystemEvent(
        admin,
        "lending_auto_repayment",
        loan.borrower_user_id,
        "lending_agent_loans",
        loan.id,
        {
          amount: deductible,
          lender_agent_id: loan.lender_agent_id,
          reference: ref,
          overdue_dates_before: overdueBefore,
          overdue_dates_after: overdueAfter,
          remaining_balance_ugx: newOutstanding,
        },
      );

      await notifyBorrower(
        admin,
        loan,
        today,
        "deducted",
        deductible,
        newOutstanding,
        overdueAfter,
      );

      results.push({
        loan_id: loan.id,
        action: "deducted",
        amount: deductible,
        partial: deductible < target,
        fully_repaid: fullyRepaid,
      });
    }

    return new Response(
      JSON.stringify({ ok: true, processed: results.length, results }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error("[lending-auto-deduct] error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String((err as Error)?.message ?? err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});