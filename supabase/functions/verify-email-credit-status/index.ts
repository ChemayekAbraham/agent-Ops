// Authoritative backend verifier for whether a parsed Gmail money-in
// transaction has ALREADY been credited to a wallet. Financial Ops calls
// this immediately before invoking `cfo-direct-credit` so a stale
// frontend cache cannot cause a double-credit.
//
// Two independent sources of truth are checked, and the strictest result
// wins:
//   1. `deposit_requests` linked to this email via
//      `gmail_transactions.linked_deposit_request_id` (fast path) OR
//      `auto_match_audit->>gmail_message_id` (fallback).
//   2. `general_ledger` wallet-scope `cash_in` legs whose
//      `sub_category` equals the email's transaction_id (TID).
//
// Decision returned in `safe_to_credit`:
//   - false + reason `DUPLICATE_DEPOSIT` when an active (non-terminal,
//     non-reversed) deposit exists for the same target user.
//   - false + reason `DUPLICATE_LEDGER_LEG` when a wallet `cash_in` leg
//     tagged with the TID already exists for the same target user.
//   - false + reason `AMOUNT_MISMATCH` when the email amount and the
//     proposed credit amount diverge by more than 1 UGX (cents rounding).
//   - false + reason `REFERENCE_MISSING` when no TID is on the email and
//     no caller-provided reference was supplied (we cannot reconcile).
//   - true otherwise.
//
// Terminal statuses (rejected/cancelled/failed/reversed) and ledger legs
// classified as admin_correction / system_balance_correction are ignored
// so a previously reversed auto-credit does NOT block re-routing.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const TERMINAL = new Set(["rejected", "cancelled", "failed", "reversed"]);

type Reason =
  | "OK"
  | "DUPLICATE_DEPOSIT"
  | "DUPLICATE_LEDGER_LEG"
  | "AMOUNT_MISMATCH"
  | "REFERENCE_MISSING"
  | "EMAIL_NOT_FOUND";

interface CreditedDepositOut {
  deposit_id: string;
  user_id: string;
  user_name: string;
  user_phone: string;
  amount: number;
  status: string;
  auto_approved: boolean | null;
  deposit_purpose: string | null;
  credited_at: string | null;
}

interface LedgerLegOut {
  ledger_id: string;
  user_id: string;
  amount: number;
  wallet_bucket: string | null;
  transaction_date: string;
  category: string;
}

interface VerifyResult {
  safe_to_credit: boolean;
  reason: Reason;
  message: string;
  email: {
    id: string;
    gmail_message_id: string | null;
    transaction_id: string | null;
    amount: number | null;
    direction: string | null;
  } | null;
  credited_deposit: CreditedDepositOut | null;
  ledger_legs: LedgerLegOut[];
  amount_match: { email_amount: number | null; proposed_amount: number | null; matches: boolean } | null;
  reference_match: { email_tid: string | null; proposed_reference: string | null; matches: boolean } | null;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const token = authHeader.slice("Bearer ".length);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);

  // Caller must be a financial role — same gate as cfo-direct-credit.
  const { data: roles } = await adminClient
    .from("user_roles")
    .select("role")
    .eq("user_id", userData.user.id)
    .in("role", ["cfo", "manager", "super_admin", "cto", "operations"]);
  if (!roles?.length) return json({ error: "Insufficient permissions" }, 403);

  let body: {
    gmail_transaction_id?: unknown;
    gmail_message_id?: unknown;
    target_user_id?: unknown;
    proposed_amount?: unknown;
    proposed_reference?: unknown;
    amount_tolerance_ugx?: unknown;
  };
  try { body = await req.json(); } catch { return json({ error: "Malformed JSON" }, 400); }

  const gmailTxId = typeof body.gmail_transaction_id === "string" && body.gmail_transaction_id ? body.gmail_transaction_id : null;
  const gmailMsgId = typeof body.gmail_message_id === "string" && body.gmail_message_id ? body.gmail_message_id : null;
  const targetUserId = typeof body.target_user_id === "string" && body.target_user_id ? body.target_user_id : null;
  const proposedAmt = typeof body.proposed_amount === "number" ? body.proposed_amount
    : (typeof body.proposed_amount === "string" && body.proposed_amount.length ? Number(body.proposed_amount) : null);
  const proposedRef = typeof body.proposed_reference === "string" && body.proposed_reference.trim().length
    ? body.proposed_reference.trim() : null;
  const tolerance = Math.max(0, typeof body.amount_tolerance_ugx === "number" ? body.amount_tolerance_ugx : 1);

  if (!gmailTxId && !gmailMsgId) {
    return json({ error: "gmail_transaction_id or gmail_message_id is required" }, 400);
  }

  try {
    // 1) Resolve the email row authoritatively.
    let emailQ = adminClient
      .from("gmail_transactions")
      .select("id, gmail_message_id, transaction_id, amount, direction, linked_deposit_request_id");
    if (gmailTxId) emailQ = emailQ.eq("id", gmailTxId);
    else emailQ = emailQ.eq("gmail_message_id", gmailMsgId!);
    const { data: emailRow, error: emailErr } = await emailQ.maybeSingle();
    if (emailErr) throw emailErr;

    const emailOut = emailRow
      ? {
          id: emailRow.id as string,
          gmail_message_id: (emailRow.gmail_message_id as string | null) ?? null,
          transaction_id: (emailRow.transaction_id as string | null) ?? null,
          amount: emailRow.amount === null ? null : Number(emailRow.amount),
          direction: (emailRow.direction as string | null) ?? null,
        }
      : null;

    if (!emailRow) {
      const result: VerifyResult = {
        safe_to_credit: false,
        reason: "EMAIL_NOT_FOUND",
        message: "Email row not found — refusing to credit.",
        email: null, credited_deposit: null, ledger_legs: [],
        amount_match: null, reference_match: null,
      };
      return json(result);
    }

    const tid = (emailRow.transaction_id as string | null)?.trim() || null;
    const effectiveRef = tid || proposedRef;

    // 2) Look up linked deposit_requests via fast path + audit fallback.
    const depIds = new Set<string>();
    if (emailRow.linked_deposit_request_id) depIds.add(emailRow.linked_deposit_request_id as string);
    if (emailRow.gmail_message_id) {
      const { data: byAudit } = await adminClient
        .from("deposit_requests")
        .select("id")
        .eq("auto_match_audit->>gmail_message_id", emailRow.gmail_message_id as string);
      for (const r of (byAudit ?? []) as Array<{ id: string }>) depIds.add(r.id);
    }

    let activeDeposit: CreditedDepositOut | null = null;
    if (depIds.size) {
      const { data: deps } = await adminClient
        .from("deposit_requests")
        .select("id, user_id, amount, status, auto_approved, deposit_purpose, created_at, updated_at")
        .in("id", Array.from(depIds));
      const candidates = (deps ?? []).filter((d: any) => !TERMINAL.has(d.status));
      if (candidates.length) {
        const pick: any = candidates[0];
        const { data: prof } = await adminClient
          .from("profiles").select("id, full_name, phone").eq("id", pick.user_id).maybeSingle();
        activeDeposit = {
          deposit_id: pick.id,
          user_id: pick.user_id,
          user_name: (prof?.full_name as string) ?? "Unknown user",
          user_phone: (prof?.phone as string) ?? "",
          amount: Number(pick.amount) || 0,
          status: pick.status,
          auto_approved: pick.auto_approved ?? null,
          deposit_purpose: pick.deposit_purpose ?? null,
          credited_at: (pick.updated_at as string) ?? (pick.created_at as string) ?? null,
        };
      }
    }

    // 3) Look up wallet-scope cash_in ledger legs tagged with the TID.
    let legs: LedgerLegOut[] = [];
    if (tid) {
      const { data: gl } = await adminClient
        .from("general_ledger")
        .select("id, user_id, amount, wallet_bucket, transaction_date, category, classification")
        .eq("ledger_scope", "wallet")
        .eq("direction", "cash_in")
        .eq("sub_category", tid)
        .neq("classification", "admin_correction")
        .neq("category", "system_balance_correction")
        .order("transaction_date", { ascending: false })
        .limit(20);
      legs = ((gl ?? []) as Array<any>).map((r) => ({
        ledger_id: r.id,
        user_id: r.user_id,
        amount: Number(r.amount) || 0,
        wallet_bucket: r.wallet_bucket ?? null,
        transaction_date: r.transaction_date,
        category: r.category,
      }));
    }

    // 4) Amount & reference comparisons.
    const emailAmt = emailRow.amount === null ? null : Number(emailRow.amount);
    const amountMatch = proposedAmt === null || emailAmt === null
      ? { email_amount: emailAmt, proposed_amount: proposedAmt, matches: true }
      : { email_amount: emailAmt, proposed_amount: proposedAmt, matches: Math.abs(emailAmt - proposedAmt) <= tolerance };

    const referenceMatch = {
      email_tid: tid,
      proposed_reference: proposedRef,
      matches: !!effectiveRef && (!proposedRef || !tid || proposedRef.toUpperCase() === tid.toUpperCase()),
    };

    // 5) Decide.
    let safe = true;
    let reason: Reason = "OK";
    let message = "No prior credit found — safe to credit.";

    if (activeDeposit && targetUserId && activeDeposit.user_id === targetUserId) {
      safe = false;
      reason = "DUPLICATE_DEPOSIT";
      message = `Deposit ${activeDeposit.deposit_id} already credited UGX ${Math.round(activeDeposit.amount).toLocaleString()} to ${activeDeposit.user_name} (status: ${activeDeposit.status}).`;
    } else if (legs.length && targetUserId && legs.some((l) => l.user_id === targetUserId)) {
      safe = false;
      reason = "DUPLICATE_LEDGER_LEG";
      const dup = legs.find((l) => l.user_id === targetUserId)!;
      message = `Wallet ledger already has a cash_in leg of UGX ${Math.round(dup.amount).toLocaleString()} for this TID on ${dup.transaction_date}.`;
    } else if (!amountMatch.matches) {
      safe = false;
      reason = "AMOUNT_MISMATCH";
      message = `Email amount UGX ${Math.round(emailAmt ?? 0).toLocaleString()} differs from proposed credit UGX ${Math.round(proposedAmt ?? 0).toLocaleString()} (tolerance ${tolerance}).`;
    } else if (!effectiveRef) {
      safe = false;
      reason = "REFERENCE_MISSING";
      message = "Email has no transaction reference and none was supplied — cannot reconcile.";
    } else if (activeDeposit) {
      // Deposit exists but for a DIFFERENT user — caller may proceed
      // (the dialog handles reversal), but flag it informationally.
      message = `Email already linked to deposit ${activeDeposit.deposit_id} for ${activeDeposit.user_name}; reversal required before crediting another user.`;
    }

    const result: VerifyResult = {
      safe_to_credit: safe,
      reason,
      message,
      email: emailOut,
      credited_deposit: activeDeposit,
      ledger_legs: legs,
      amount_match: amountMatch,
      reference_match: referenceMatch,
    };
    return json(result);
  } catch (e) {
    console.error("[verify-email-credit-status] failed", e);
    return json({ error: (e as Error).message ?? "Internal error" }, 500);
  }
});
