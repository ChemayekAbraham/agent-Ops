// Lending Agent disbursement: moves the loan principal from the lending
// agent's withdrawable wallet into the borrower's withdrawable wallet through
// the single-writer create_ledger_transaction RPC, records the loan with its
// repayment schedule, and SMS-notifies the borrower.
import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Frequency = "daily" | "weekly" | "monthly" | "once" | "end_of_month";

const PLATFORM_FEE_PCT = 0.01;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function lastDayOfMonth(year: number, monthIdx: number): Date {
  return new Date(Date.UTC(year, monthIdx + 1, 0));
}

function periodsFor(freq: Frequency, start: Date, due: Date): number {
  if (freq === "once" || due <= start) return 1;
  const days = Math.max(1, Math.round((due.getTime() - start.getTime()) / 86400000));
  switch (freq) {
    case "daily": return Math.max(1, days);
    case "weekly": return Math.max(1, Math.ceil(days / 7));
    case "monthly": return Math.max(1, Math.ceil(days / 30));
    case "end_of_month": return Math.max(1, Math.ceil(days / 30));
    default: return 1;
  }
}

function firstDeductionDate(freq: Frequency, start: Date, due: Date): string {
  const d = new Date(start.getTime());
  switch (freq) {
    case "daily": d.setUTCDate(d.getUTCDate() + 1); return ymd(d);
    case "weekly": d.setUTCDate(d.getUTCDate() + 7); return ymd(d);
    case "monthly": d.setUTCMonth(d.getUTCMonth() + 1); return ymd(d);
    case "end_of_month": return ymd(lastDayOfMonth(d.getUTCFullYear(), d.getUTCMonth()));
    case "once":
    default: return ymd(due > start ? due : d);
  }
}

function fmtUGX(n: number): string {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "Missing authorization" }, 401);
    const { data: authData, error: authError } = await admin.auth.getUser(token);
    const lenderId = authData?.user?.id;
    if (authError || !lenderId) return json({ error: "Invalid session" }, 401);

    const body = await req.json().catch(() => ({}));
    const borrowerUserId: string = body?.borrower_user_id ?? "";
    const principal = Math.floor(Number(body?.principal_ugx ?? 0));
    const interestRate = Math.max(0, Number(body?.interest_rate_pct ?? 0));
    const freq: Frequency = (body?.repayment_frequency ?? "monthly") as Frequency;
    const autoDeduct = body?.auto_deduct_enabled !== false;
    const dueDateStr: string | null = body?.expected_repayment_date || null;
    const purpose: string | null = (body?.loan_purpose ?? "").toString().trim() || null;

    if (!/^[0-9a-f-]{36}$/i.test(borrowerUserId)) {
      return json({ error: "A valid borrower must be selected" }, 400);
    }
    if (borrowerUserId === lenderId) {
      return json({ error: "You cannot lend to yourself" }, 400);
    }
    if (!Number.isFinite(principal) || principal < 1000) {
      return json({ error: "Enter a loan amount of at least UGX 1,000" }, 400);
    }
    if (interestRate > 200) {
      return json({ error: "Interest rate looks invalid" }, 400);
    }
    if (!["daily", "weekly", "monthly", "once", "end_of_month"].includes(freq)) {
      return json({ error: "Invalid repayment frequency" }, 400);
    }

    // Lending Agent Agreement must be signed.
    const { data: agreement } = await admin
      .from("lending_agent_agreement_acceptance")
      .select("status")
      .eq("agent_user_id", lenderId)
      .eq("status", "accepted")
      .maybeSingle();
    if (!agreement) return json({ error: "Sign the Lending Agent Agreement first" }, 403);

    const fee = Math.round(principal * PLATFORM_FEE_PCT);

    // Strict withdrawable gate on the lender's wallet.
    const { data: availRaw, error: availError } = await admin.rpc(
      "get_user_available_balance",
      { p_user_id: lenderId },
    );
    if (availError) return json({ error: availError.message }, 400);
    const available = Math.max(0, Math.floor(Number(availRaw ?? 0)));
    if (principal + fee > available) {
      return json({
        error: `Insufficient wallet balance. You have ${fmtUGX(available)} but need ${fmtUGX(principal + fee)} (loan + 1% fee).`,
      }, 400);
    }

    const [{ data: borrowerProfile }, { data: lenderProfile }, { data: borrowerTrust }] = await Promise.all([
      admin.from("profiles").select("id, full_name, phone").eq("id", borrowerUserId).maybeSingle(),
      admin.from("profiles").select("id, full_name, phone").eq("id", lenderId).maybeSingle(),
      admin.from("welile_trust_score_cache").select("ai_id, score, tier").eq("user_id", borrowerUserId).maybeSingle(),
    ]);
    if (!borrowerProfile) return json({ error: "Borrower account not found" }, 404);

    // borrower_ai_id is NOT NULL in the DB: resolve from the trust cache, fall back to the request, then a deterministic id.
    const borrowerAiId = String(
      body?.borrower_ai_id ?? borrowerTrust?.ai_id ?? `WAI-${borrowerUserId.slice(0, 8).toUpperCase()}`,
    );

    const borrowerLabel = borrowerProfile.full_name || "Borrower";
    const lenderLabel = lenderProfile?.full_name || "Welile lending agent";


    const start = new Date();
    const due = dueDateStr ? new Date(dueDateStr) : new Date(start.getTime() + 30 * 86400000);
    const totalOwed = Math.round(principal + (principal * interestRate) / 100);
    const periods = periodsFor(freq, start, due);
    const installment = Math.max(1, Math.ceil(totalOwed / periods));
    const firstDate = firstDeductionDate(freq, start, due);

    // Ensure both wallets exist.
    await admin.from("wallets").upsert(
      [{ user_id: lenderId, balance: 0 }, { user_id: borrowerUserId, balance: 0 }],
      { onConflict: "user_id", ignoreDuplicates: true },
    );

    const { data: loanRow, error: insertError } = await admin
      .from("lending_agent_loans")
      .insert({
        lender_agent_id: lenderId,
        borrower_user_id: borrowerUserId,
        borrower_display_name: borrowerProfile.full_name,
        borrower_phone: borrowerProfile.phone,
        borrower_ai_id: borrowerAiId,
        borrower_trust_score_at_record: borrowerTrust?.score != null ? Math.round(Number(borrowerTrust.score)) : null,
        borrower_trust_tier_at_record: borrowerTrust?.tier ?? null,

        principal_ugx: principal,
        interest_rate_pct: interestRate,
        expected_repayment_date: dueDateStr,
        loan_purpose: purpose,
        platform_fee_ugx: fee,
        status: "active",
        repayment_frequency: autoDeduct ? freq : "once",
        auto_deduct_enabled: autoDeduct,
        installment_ugx: autoDeduct ? installment : 0,
        next_deduction_date: autoDeduct ? firstDate : null,
        auto_deduct_started_at: autoDeduct ? new Date().toISOString() : null,
      })
      .select("id")
      .single();
    if (insertError) return json({ error: insertError.message }, 400);

    const loanId = loanRow!.id as string;
    const ref = `LND-${loanId.slice(0, 8)}`;
    const nowIso = new Date().toISOString();

    const { error: ledgerError } = await admin.rpc("create_ledger_transaction", {
      entries: [
        {
          user_id: lenderId,
          amount: principal,
          direction: "cash_out",
          category: "wallet_transfer",
          ledger_scope: "wallet",
          source_table: "lending_agent_loans",
          source_id: loanId,
          description: `Loan disbursed to ${borrowerLabel}`,
          currency: "UGX",
          transaction_date: nowIso,
          reference_id: ref,
          linked_party: borrowerLabel,
          recipient_type: "user",
        },
        {
          user_id: borrowerUserId,
          amount: principal,
          direction: "cash_in",
          category: "wallet_transfer",
          ledger_scope: "wallet",
          source_table: "lending_agent_loans",
          source_id: loanId,
          description: `Loan received from ${lenderLabel}`,
          currency: "UGX",
          transaction_date: nowIso,
          reference_id: ref,
          linked_party: lenderLabel,
          recipient_type: "user",
        },
      ],
      idempotency_key: ref,
    });

    if (ledgerError) {
      // Money never moved — do not leave a phantom active loan behind.
      await admin.from("lending_agent_loans").delete().eq("id", loanId);
      console.error(`lending-disburse-loan ledger failure: ${ledgerError.message}`);
      return json({ error: `Transfer failed: ${ledgerError.message}` }, 400);
    }

    // Notify the borrower (best effort — never fails the disbursement).
    let smsSent = false;
    if (borrowerProfile.phone) {
      const scheduleLine = autoDeduct
        ? (freq === "once"
          ? `Repay ${fmtUGX(totalOwed)} in one payment on ${firstDate}. It will be auto-deducted from your wallet.`
          : `Repayment: ${periods} ${freq.replace("_", " ")} installments of about ${fmtUGX(installment)}, auto-deducted from your wallet starting ${firstDate}.`)
        : `Total repayable ${fmtUGX(totalOwed)}${dueDateStr ? ` by ${dueDateStr}` : ""}.`;
      const msg = `Welile: ${fmtUGX(principal)} loan from ${lenderLabel} has been added to your wallet. Interest ${interestRate}%. ${scheduleLine} Contact your lender on ${lenderProfile?.phone ?? "the app"}.`;
      try {
        smsSent = await sendSMS(borrowerProfile.phone, msg, {
          admin,
          source: "lending-disburse-loan",
          reference_id: ref,
          recipient_user_id: borrowerUserId,
          recipient_name: borrowerLabel,
          idempotencyKey: `LND-SMS-${loanId.slice(0, 12)}`,
        });
      } catch (err) {
        console.error("lending-disburse-loan sms failure:", (err as Error)?.message);
      }
    }

    return json({
      success: true,
      loan_id: loanId,
      principal_ugx: principal,
      platform_fee_ugx: fee,
      total_owed_ugx: totalOwed,
      installment_ugx: autoDeduct ? installment : 0,
      periods: autoDeduct ? periods : 1,
      first_deduction_date: autoDeduct ? firstDate : null,
      sms_sent: smsSent,
    });
  } catch (err) {
    console.error("lending-disburse-loan error:", (err as Error)?.message);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
