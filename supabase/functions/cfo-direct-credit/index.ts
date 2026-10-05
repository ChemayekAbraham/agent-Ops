import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { runShadowAudit } from "../_shared/shadowLogger.ts";
import { shadowValidateCfoAdjustment } from "../_shared/shadowValidation.ts";
import { fetchShadowConfig, shouldSample } from "../_shared/shadowConfig.ts";
import { checkTreasuryGuard } from "../_shared/treasuryGuard.ts";
import { resolveManagedProxy } from "../_shared/partnership-emails.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";
import { learnDepositNumber, toLast9, learnDepositName } from "../_shared/depositNumberLearning.ts";
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from "../_shared/cfoApprovalGate.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ── SMS helper (Africa's Talking) ─────────────────────────────────────
// Mirrors approve-withdrawal so a recipient gets an immediate text alert
// whenever the CFO sends money to their wallet.
function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return digits ? `+${digits}` : "";
}
function isUgandanPhone(phone: string): boolean {
  const f = formatPhoneInternational(phone);
  return f.startsWith("+256") && f.length >= 13;
}
interface SmsLogMeta {
  recipientUserId?: string | null;
  recipientName?: string | null;
  referenceId?: string | null;
  source?: string;
}

// Records every send attempt to public.sms_delivery_log so the admin view can
// show sent/failed status, the raw provider response, cost, timestamp and the
// linked transaction reference.
async function logSmsDelivery(row: Record<string, unknown>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, key);
    await admin.from("sms_delivery_log").insert(row);
  } catch (e) {
    console.error("[cfo-direct-credit] sms_delivery_log insert failed:", (e as Error).message);
  }
}

async function sendSMS(phone: string, message: string, meta: SmsLogMeta = {}): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "cfo-direct-credit" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  const source = meta.source ?? "cfo-direct-credit";
  const baseRow = {
    recipient_phone: formatPhoneInternational(phone) || phone,
    recipient_user_id: meta.recipientUserId ?? null,
    recipient_name: meta.recipientName ?? null,
    message,
    reference_id: meta.referenceId ?? null,
    source,
    provider: "africastalking",
  };
  if (!apiKey || !username) {
    await logSmsDelivery({ ...baseRow, status: "failed", error: "Missing Africa's Talking credentials" });
    return false;
  }
  if (!isUgandanPhone(phone)) {
    await logSmsDelivery({ ...baseRow, status: "failed", error: "Invalid/non-Ugandan phone number" });
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const data = await res.json();
    const recipient = (data?.SMSMessageData?.Recipients || [])[0];
    const success = recipient?.statusCode === 101 || recipient?.statusCode === 100;
    await logSmsDelivery({
      ...baseRow,
      status: success ? "sent" : "failed",
      provider_message_id: recipient?.messageId ?? null,
      cost: recipient?.cost ?? null,
      provider_response: data ?? null,
      error: success ? null : (recipient?.status ?? data?.SMSMessageData?.Message ?? "Provider rejected message"),
    });
    return success;
  } catch (err) {
    await logSmsDelivery({ ...baseRow, status: "failed", error: (err as Error).message });
    console.error("[cfo-direct-credit] SMS error:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceKey);

  // Fetch shadow config once (cached 60s)
  const shadowConfig = await fetchShadowConfig(adminClient);

  try {
    const authHeader = req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      console.error("Missing or invalid Authorization header");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");

    // Parse the body once so we can detect the automated service-role path
    // BEFORE attempting (and failing) a human-JWT verification.
    const body = await req.json();

    // ── System auto-debit path (service-role, no human CFO) ───────────────
    // The Gmail poller invokes this with the service-role key and
    // `system_auto_debit: true` to charge a parsed outgoing payout email
    // against the recipient's wallet automatically — no manual CFO click.
    // The service-role bearer IS the authority here, so we skip the human
    // JWT/role gate and resolve a finance actor for the platform ledger leg.
    const isSystemAutoDebit =
      token === serviceKey && body?.system_auto_debit === true && body?.operation === "debit";

    // ── System requisition credit path (service-role, no human CFO) ───────
    // requisition-decide / requisition-credit-retry post the approved
    // requisition credit server-to-server with the service-role key and
    // `system_requisition_credit: true`. The human authority (CFO / manager /
    // super_admin) was already verified by the calling function, and the
    // service-role bearer IS the authority on this hop — same mechanism as
    // the auto-debit path above, just for a credit.
    const isSystemRequisitionCredit =
      token === serviceKey && body?.system_requisition_credit === true && body?.operation !== "debit";
    const isSystemAuthored = isSystemAutoDebit || isSystemRequisitionCredit;

    let user: { id: string };
    let callerRoles: string[];
    // Set when a Financial Ops user who is NOT the CFO approver is allowed through
    // for one narrow job: routing a real incoming email receipt to a wallet.
    // Verified against the request body further down; every other credit or
    // debit stays pinned to the CFO approver.
    let finOpsEmailRoutingOnly = false;

    if (isSystemAuthored) {
      const { data: actor } = await adminClient
        .from("user_roles")
        .select("user_id")
        .in("role", ["cfo", "financial_ops", "super_admin"])
        .limit(1)
        .maybeSingle();
      if (!actor?.user_id) {
        return new Response(JSON.stringify({ error: "No finance actor available for system-authored posting" }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: actor.user_id };
      callerRoles = [isSystemAutoDebit ? "system_auto_debit" : "system_requisition_credit"];
      // Treasury guard still applies to automated money movement.
      const guardBlock = await checkTreasuryGuard(adminClient, "any", actor.user_id);
      if (guardBlock) return guardBlock;
    } else {
      // Use admin client to verify the JWT token
      const { data: { user: authedUser }, error: authError } = await adminClient.auth.getUser(token);
      if (authError || !authedUser) {
        console.error("Auth verification failed:", authError?.message || "No user");
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Treasury guard: block any money movement when paused. Pass the
      // already-validated caller UUID so CTO / super_admin maintenance bypass is
      // deterministic and does not depend on bearer-token re-validation.
      const guardBlock = await checkTreasuryGuard(adminClient, "any", authedUser.id);
      if (guardBlock) return guardBlock;

      const { data: roles } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", authedUser.id)
        .in("role", ["cfo", "financial_ops", "super_admin"]);

      // Financial Ops staff = the cfo / financial_ops / super_admin roles, OR a
      // Financial Ops dashboard permission (same definition as the web's
      // is_financial_ops_staff). Holding the permission alone is enough to
      // route an email receipt; it does not unlock anything CFO-only.
      let finOpsStaff = !!roles?.length;
      if (!finOpsStaff) {
        const { data: staffOk } = await adminClient.rpc("is_financial_ops_staff", { p_user: authedUser.id });
        finOpsStaff = staffOk === true;
      }
      if (!finOpsStaff) {
        return new Response(JSON.stringify({ error: "Insufficient permissions" }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      user = { id: authedUser.id };
      callerRoles = (roles || []).map((r: any) => r.role);
      if (!callerRoles.length) callerRoles = ["financial_ops_staff"];
      // CFO Direct Credit/Debit acting in a CFO capacity is restricted to the
      // designated CFO approver. Manual credits and debits are pinned to the Chief
      // Finance Officer office and the designated super admins.
      //
      // Exception: routing a real incoming email receipt to the wallet it belongs
      // to ("Send to wallet" in Financial Ops > Email Transactions) is Financial
      // Ops' own duty. Anyone who got this far is Financial Ops staff, so a
      // non-approver may do that and only that; the request is checked against
      // the receipt below.
      if (!(await isCfoApprover(adminClient, authedUser.id))) {
        finOpsEmailRoutingOnly = true;
      }
    }
    const userId = user.id;

    const { target_user_id, amount: rawAmount, reason, operation, wallet_category, platform_category, financial_impact, category_label, sub_category, recipient_type, allow_overdraw: rawAllowOverdraw, solvency_bypass_reason: rawSolvencyReason, gmail_transaction_id: rawGmailTxId, gmail_message_id: rawGmailMsgId, email_tid: rawEmailTid, manual_credit: rawManualCredit, source_phone: rawSourcePhone, source_name: rawSourceName } = body;
    // Phone number seen on the email receipt that this credit came from. When
    // Financial Ops manually routes a deposit sent from a number that is not on
    // the recipient's account, we learn it (below) so the NEXT deposit from that
    // number auto-credits instead of returning to the manual queue.
    const sourcePhoneLast9 = toLast9(typeof rawSourcePhone === "string" ? rawSourcePhone : null);
    // Payer NAME seen on the email receipt (MTN till receipts carry only a
    // name, never a phone). Same idea as sourcePhoneLast9, keyed by name
    // instead — see learnDepositName below.
    const sourceName = typeof rawSourceName === "string" && rawSourceName.trim() ? rawSourceName.trim() : null;
    // The manual CFO Direct Credit / Withdraw tool sets `manual_credit: true`.
    // Manual payouts must ALWAYS be allowed — any user, any time, any category,
    // any sub-category, countless times — so they are NEVER subject to the
    // email-origin idempotency gate. Email-routing flows do NOT set this flag,
    // so their genuine double-credit protection is fully preserved.
    const isManualCredit = rawManualCredit === true;
    const amount = typeof rawAmount === "number"
      ? rawAmount
      : Number(String(rawAmount ?? "").replace(/[, _]/g, ""));
    const op = operation === "debit" ? "debit" : "credit";

    // Normalise email-origin identifiers (any may be null)
    const gmailTxId: string | null = typeof rawGmailTxId === "string" && rawGmailTxId ? rawGmailTxId : null;
    const gmailMsgId: string | null = typeof rawGmailMsgId === "string" && rawGmailMsgId ? rawGmailMsgId : null;

    // ── Financial Ops email-routing allowance ───────────────────────────────
    // A non-approver Financial Ops user passes only when ALL of these hold, so
    // the allowance cannot be used to post an arbitrary credit:
    //   • it is a credit, not a debit, and not the free-form manual tool
    //   • no forced overdraw / solvency-bypass (those stay CFO-only)
    //   • a deposit category only
    //   • it references a real incoming email receipt, for exactly that amount
    // The email idempotency reservation further down still stops a second
    // credit for the same receipt.
    if (finOpsEmailRoutingOnly) {
      const denyFinOps = () => cfoApproverDenied(corsHeaders);
      if (
        op !== "credit" || isManualCredit || !gmailTxId ||
        rawAllowOverdraw === true || rawSolvencyReason ||
        (wallet_category !== "wallet_deposit" && wallet_category !== "agent_float_deposit") ||
        !Number.isFinite(amount) || amount <= 0
      ) {
        return denyFinOps();
      }
      const { data: receipt } = await adminClient
        .from("gmail_transactions")
        .select("id, amount, direction")
        .eq("id", gmailTxId)
        .maybeSingle();
      if (!receipt || receipt.direction !== "in" || Math.abs(Number(receipt.amount) - amount) > 1) {
        return denyFinOps();
      }
    }
    // The idempotency key MUST be a real email / MoMo transaction reference.
    // It may arrive explicitly as `email_tid`, or be carried in `sub_category`
    // by the email-routing flows (which set sub_category = the email's
    // transaction_id). The CFO's manual Direct Credit tool ALSO sends a
    // `sub_category`, but there it is a generic accounting slug ("food",
    // "rent", "property_equipment", …) that repeats by design and must NEVER
    // act as a duplicate-prevention key — otherwise the second legitimate
    // payout to the same user under the same category is wrongly blocked as
    // DUPLICATE_EMAIL_CREDIT. Real transaction references always contain at
    // least one digit (TIDs, MoMo refs, gmail hex ids); generic accounting
    // slugs are lowercase words/underscores with no digits. We use that to
    // tell them apart.
    const looksLikeTxnRef = (v: unknown): v is string =>
      typeof v === "string" && v.length >= 4 && /\d/.test(v);
    // For manual CFO payouts we ignore every potential idempotency key so the
    // tool can pay the same user under the same category endlessly.
    const emailTid: string | null = isManualCredit
      ? null
      : (looksLikeTxnRef(rawEmailTid)
          ? rawEmailTid
          : (looksLikeTxnRef(sub_category) ? sub_category : null));
    const effectiveGmailMsgId: string | null = isManualCredit ? null : gmailMsgId;
    // Email-origin idempotency applies to BOTH credits and debits. The
    // outgoing-payout auto-debit (gmail-poll-transactions) and the backlog
    // sweep (sweep-payout-debits) can run concurrently on the same email;
    // reserving a row in email_credit_idempotency (unique on
    // gmail_message_id+user and email_tid+user) BEFORE posting the ledger
    // guarantees the second worker fails fast with 409 and never debits twice.
    const isEmailOriginGuarded = (op === "credit" || op === "debit") && !!(effectiveGmailMsgId || emailTid);

    // ── Forced reversal mode ────────────────────────────────────────────
    // Email-deposit rerouting and other recovery workflows may need to
    // debit a wallet whose strict balance is 0 (the user already withdrew
    // the mis-credit). Operators with CFO/manager/super_admin authority
    // can pass `allow_overdraw: true` on a debit; we then stamp the
    // wallet leg with classification='admin_correction' so the
    // enforce_no_negative_wallet_ledger trigger lets it through, and we
    // flag the matching cfo_debit_obligations row with auto_recover=true
    // so the existing recovery cron settles it from future incoming
    // credits. Credits ignore the flag.
    const requestedAllowOverdraw = op === "debit" && rawAllowOverdraw === true;

    // ── Structured solvency-bypass reason ─────────────────────────────────
    // The DB trigger enforce_no_negative_wallet_ledger requires this code on
    // any cash_out wallet leg classified as admin_correction. Forced reversals
    // (allow_overdraw=true) are the only path here that stamps that
    // classification, so they MUST carry a code. We validate against the
    // canonical enum so a typo can't silently bypass the guard.
    const SOLVENCY_BYPASS_REASONS = new Set([
      'legacy_offline_paid', 'write_off', 'admin_correction_seed',
      'legacy_real_backfill', 'dispute_resolution', 'regulatory_adjustment',
      'duplicate_reversal', 'other_with_note',
    ]);
    let solvencyBypassReason: string | null =
      typeof rawSolvencyReason === 'string' && SOLVENCY_BYPASS_REASONS.has(rawSolvencyReason)
        ? rawSolvencyReason
        : null;
    if (typeof rawSolvencyReason === 'string' && rawSolvencyReason && !solvencyBypassReason) {
      return new Response(JSON.stringify({
        error: 'INVALID_SOLVENCY_BYPASS_REASON: use one of: ' + [...SOLVENCY_BYPASS_REASONS].join(', ') + '.',
      }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ── HARD CATEGORY → BUCKET LOCKS (Wallet Routing v2.1) ───────────────
    // These categories are the ONLY signal that decides the wallet bucket.
    // recipient_type must agree, otherwise the request is rejected. No
    // fallback, no inference — if the operator picks the wrong recipient
    // for one of these locked categories the request fails fast.
    //
    //   agent_float_deposit       → ALWAYS Float        (operational_wallet)
    //   agent_commission_earned   → ALWAYS Withdrawable (user)
    //
    const CATEGORY_BUCKET_LOCK: Record<string, { bucket: 'float' | 'withdrawable'; recipient: 'user' | 'operational_wallet'; label: string }> = {
      agent_float_deposit:     { bucket: 'float',        recipient: 'operational_wallet', label: 'Agent Float Allocation' },
      agent_commission_earned: { bucket: 'withdrawable', recipient: 'user',               label: 'Agent Commission' },
    };

    const lock = wallet_category && CATEGORY_BUCKET_LOCK[wallet_category as string];
    if (lock && recipient_type !== lock.recipient) {
      return new Response(JSON.stringify({
        error: `INVALID_ROUTING: '${lock.label}' is locked to ${lock.bucket === 'float' ? 'Operational Wallet (Float)' : 'User (Withdrawable)'}. Got recipient_type='${recipient_type}'.`,
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const walletBucket = lock
      ? lock.bucket
      : (recipient_type === "operational_wallet" ? "float" : "withdrawable");
    // Bucket-aware rule: Forced Reversal (personal recoverable debt) is a
    // WITHDRAWABLE-only concept. A float correction can never overdraw the
    // float bucket and can never become a personal liability.
    const allowOverdraw = requestedAllowOverdraw && walletBucket !== "float";
    const routingSource = lock
      ? `cfo_direct_${op}_locked_${wallet_category}`
      : (op === "credit" ? "cfo_direct_credit_explicit_bucket" : "cfo_direct_debit_explicit_bucket");

    // ── Wallet Routing v2: recipient_type is the SOLE routing signal ───────
    // user                → money goes to withdrawable_balance (user owns it)
    // operational_wallet  → money goes to float_balance (company-controlled)
    if (!recipient_type || (recipient_type !== "user" && recipient_type !== "operational_wallet")) {
      return new Response(JSON.stringify({
        error: "RECIPIENT_TYPE_REQUIRED: choose 'user' (Withdrawable) or 'operational_wallet' (Float).",
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Allowed production categories
    const ALLOWED_CATEGORIES = [
      'roi_wallet_credit', 'roi_expense', 'agent_commission_earned',
      'system_balance_correction', 'wallet_transfer',
      'access_fee_collected', 'registration_fee_collected',
      'marketing_expense', 'payroll_expense', 'general_admin_expense',
      'research_development_expense', 'tax_expense', 'interest_expense', 'equipment_expense',
      // Agent float top-ups initiated by CFO when the standard agent deposit
      // approval path is unavailable. Routes to operational_wallet → float.
      'agent_float_deposit', 'rent_disbursement',
    ];
    // Default the wallet leg to `wallet_deposit` (user-visible) instead of
    // `system_balance_correction`, which `v_user_wallet_strict` and every
    // end-user wallet view filter out — that filter caused CFO direct credits
    // to silently disappear from users' wallets even though the cached
    // `wallets.balance` updated. See plan: Atuhaire Carolyne 26.5M repair.
    // Hard guard: when the operator chose `operational_wallet` (Float) we must
    // NEVER fall back to `wallet_deposit` (which routes to Withdrawable). If
    // the submitted category isn't in the allow-list for that path, reject
    // outright so the bug can never silently re-appear.
    const FLOAT_ROUTE_CATEGORIES = new Set([
      'agent_float_deposit', 'agent_float_assignment', 'agent_float_topup',
      'agent_float_funding', 'rent_float_funding', 'rent_disbursement',
    ]);
    if (op === 'credit' && recipient_type === 'operational_wallet') {
      if (!wallet_category || !FLOAT_ROUTE_CATEGORIES.has(wallet_category)) {
        return new Response(JSON.stringify({
          error: `INVALID_ROUTING: wallet_category '${wallet_category ?? '(none)'}' does not route to Float. Operational Wallet credits require one of: ${[...FLOAT_ROUTE_CATEGORIES].join(', ')}.`,
        }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }
    const walletCatRaw = ALLOWED_CATEGORIES.includes(wallet_category) ? wallet_category : 'wallet_deposit';

    const platformCat = ALLOWED_CATEGORIES.includes(platform_category) ? platform_category : 'system_balance_correction';

    // Expense categories (payroll, marketing, tax, etc.) describe the PLATFORM
    // leg only — they are cash_out from the company. On the recipient's WALLET
    // leg (cash_in) those categories are not routable by wallet_route_for_category
    // and the ledger raises UNSUPPORTED_LEDGER_CATEGORY. Translate to a generic
    // wallet-impact credit category for the wallet leg; the platform leg keeps
    // the real expense category for accounting/reporting.
    const EXPENSE_CATEGORIES = new Set([
      'marketing_expense', 'payroll_expense', 'general_admin_expense',
      'research_development_expense', 'tax_expense', 'interest_expense', 'equipment_expense',
    ]);
    // For credits, expense categories describe the platform leg only; the
    // recipient's wallet leg must use a user-visible deposit category so the
    // strict ledger view (which filters out system_balance_correction) shows
    // the funds.
    const walletCat = (operation !== 'debit' && EXPENSE_CATEGORIES.has(walletCatRaw))
      ? 'wallet_deposit'
      : walletCatRaw;
    const impact = ['revenue', 'expense', 'neutral'].includes(financial_impact) ? financial_impact : 'neutral';

    // `trg_enforce_correction_classification` turns correction categories into
    // admin_correction before the wallet solvency guard runs. Therefore CFO
    // debit legs using these categories need the structured reason even when
    // they are not an explicit overdraw/forced reversal.
    const SOLVENCY_REASON_CATEGORIES = new Set([
      'system_balance_correction', 'wallet_route_repair', 'admin_adjustment', 'platform_loss_writeoff',
    ]);
    const walletDebitNeedsSolvencyBypassReason = op === 'debit'
      && (allowOverdraw || SOLVENCY_REASON_CATEGORIES.has(walletCat));
    const platformCashOutNeedsSolvencyBypassReason = op === 'credit'
      && SOLVENCY_REASON_CATEGORIES.has(platformCat);
    const transactionNeedsSolvencyBypassReason = walletDebitNeedsSolvencyBypassReason
      || platformCashOutNeedsSolvencyBypassReason;
    if (transactionNeedsSolvencyBypassReason && !solvencyBypassReason) {
      const reasonText = `${category_label ?? ''} ${reason ?? ''} ${walletCat} ${platformCat} ${sub_category ?? ''}`.toLowerCase();
      solvencyBypassReason = allowOverdraw || /reverse|reversal|retract|duplicate|rerout|auto-credit|misrout|overpayment/.test(reasonText)
        ? 'duplicate_reversal'
        : /regulat|bou|cma/.test(reasonText)
          ? 'regulatory_adjustment'
          : /dispute/.test(reasonText)
            ? 'dispute_resolution'
            : /write.?off|uncollect/.test(reasonText)
              ? 'write_off'
              : 'other_with_note';
    }
    if (transactionNeedsSolvencyBypassReason && solvencyBypassReason === 'other_with_note') {
      const correctionDescriptionPreview = `${op === 'debit' ? (allowOverdraw ? 'CFO Forced Reversal' : 'CFO Debit') : 'CFO Credit'} [${category_label || walletCat}]: ${reason ?? ''}`;
      if (correctionDescriptionPreview.length < 30) {
        return new Response(JSON.stringify({
          error: 'INVALID_SOLVENCY_BYPASS_REASON: reason code other_with_note requires a description of at least 30 characters.',
        }), { status: 422, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ── Wallet Routing v2: category ↔ recipient_type compatibility check ──
    // Money owned by an individual cannot land in an operational wallet.
    const USER_OWNED_CATEGORIES = new Set([
      'payroll_expense', 'salary_payout',
      'roi_wallet_credit', 'roi_payout',
      'agent_commission_earned', 'agent_commission', 'agent_bonus',
      'partner_commission', 'referral_bonus',
      'proxy_investment_commission', 'agent_investment_commission',
      'wallet_transfer', 'manager_credit',
      'marketing_expense', 'general_admin_expense', 'research_development_expense',
      'tax_expense', 'interest_expense', 'equipment_expense',
    ]);
    const OPERATIONAL_CATEGORIES = new Set([
      'agent_float_deposit', 'agent_float_assignment', 'agent_float_topup',
      'agent_float_funding', 'rent_float_funding', 'rent_disbursement',
    ]);
    if (op === 'credit' && recipient_type === 'operational_wallet' && USER_OWNED_CATEGORIES.has(walletCat)) {
      return new Response(JSON.stringify({
        error: `INVALID_ROUTING: '${walletCat}' is money owned by the recipient — choose 'User' (Withdrawable) instead of 'Operational Wallet'.`,
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    if (op === 'credit' && recipient_type === 'user' && OPERATIONAL_CATEGORIES.has(walletCat)) {
      return new Response(JSON.stringify({
        error: `INVALID_ROUTING: '${walletCat}' is operational/company money — choose 'Operational Wallet' (Float) instead of 'User'.`,
      }), { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Validate inputs — shadow on failure paths
    if (!target_user_id || typeof target_user_id !== "string") {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('cfo-direct-credit', { target_user_id, amount, operation }, false,
          () => shadowValidateCfoAdjustment({ targetUserId: target_user_id, amount, reason, operation: op, callerRoles }), adminClient);
      }
      throw new Error("Invalid target user");
    }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 500000000) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('cfo-direct-credit', { target_user_id, amount, operation }, false,
          () => shadowValidateCfoAdjustment({ targetUserId: target_user_id, amount, reason, operation: op, callerRoles }), adminClient);
      }
      throw new Error(`Invalid amount: received '${rawAmount}' (typeof ${typeof rawAmount}). Allowed range 1 - 500,000,000.`);
    }
    if (!reason || typeof reason !== "string" || reason.trim().length < 20) {
      if (shouldSample(shadowConfig)) {
        runShadowAudit('cfo-direct-credit', { target_user_id, amount, reason, operation }, false,
          () => shadowValidateCfoAdjustment({ targetUserId: target_user_id, amount, reason, operation: op, callerRoles }), adminClient);
      }
      throw new Error("Reason must be at least 20 characters");
    }

    // Phase 5: Shadow audit on success path — sampled
    if (shouldSample(shadowConfig)) {
      runShadowAudit('cfo-direct-credit', { target_user_id, amount, operation },
        true, () => shadowValidateCfoAdjustment({ targetUserId: target_user_id, amount, reason, operation: op, callerRoles }), adminClient);
    }

    const { data: targetProfile } = await adminClient
      .from("profiles")
      .select("id, full_name, email, phone")
      .eq("id", target_user_id)
      .single();

    if (!targetProfile) throw new Error("Target user not found");

    const isRoiWalletCredit = op === "credit" && recipient_type === "user" &&
      (walletCat === "roi_wallet_credit" || platformCat === "roi_expense");
    const managedProxy = isRoiWalletCredit
      ? await resolveManagedProxy(adminClient, target_user_id)
      : null;
    const walletUserId = managedProxy ? managedProxy.agentId : target_user_id;
    const walletOwnerLabel = managedProxy
      ? `${managedProxy.agentName || "Proxy Agent"} for ${targetProfile.full_name || "partner"}`
      : targetProfile.full_name;

    // Ensure wallet exists
    const { data: existingWallet } = await adminClient
      .from("wallets")
      .select("id, balance, withdrawable_balance, float_balance")
      .eq("user_id", walletUserId)
      .single();

    if (!existingWallet) {
      await adminClient.from("wallets").insert({ user_id: walletUserId, balance: 0 });
    }

    // CFO has authority to debit regardless of balance (corrections, clawbacks)
    // Log a warning if balance is insufficient for audit trail
    if (op === "debit") {
      const bal = existingWallet?.balance ?? 0;
      if (bal < amount) {
        console.warn(`[cfo-direct-credit] CFO debit exceeds balance: user=${target_user_id} balance=${bal} debit=${amount}`);
      }
    }

    // ── Real-time strict-ledger solvency gate for CFO Debits ─────────────
    // Mirror the withdrawal flow: query `get_user_available_balance` at the
    // exact moment of the correction, using the double-entry ledger (not the
    // cached wallets.balance). If the user does not have enough available
    // AND the CFO did not explicitly enable Forced Reversal (allow_overdraw),
    // reject with a structured code so the client can offer an explicit
    // "create recoverable debt" confirmation before retrying with the flag.
    // Wallet-transfer debits (peer→peer) already run through their own
    // solvency path in create_ledger_transaction; skip only when we are
    // explicitly overdrawing.
    // ── Bucket-aware solvency gate for CFO Debits ─────────────────────────
    // The yardstick MUST follow the bucket being debited:
    //   withdrawable → get_user_available_balance (strict personal funds)
    //   float        → get_user_float_available_balance (company float only)
    // Float corrections are NEVER validated against withdrawable and NEVER
    // create a personal recoverable debt.
    //
    // Advance-reversal clawbacks (sub_category `advance_reversal:<advance_id>`)
    // are the one exception on the withdrawable side: while the treasury control
    // `advance_withdrawals_paused` is on, advance-funded withdrawable money is
    // LOCKED out of `get_user_available_balance` so agents cannot cash it out.
    // That lock exists to protect exactly the money a reversal must recover, so
    // the gate uses `get_user_advance_reversal_available` (projection
    // withdrawable minus pending holds — still ledger-backed, still never
    // negative) for these clawbacks only.
    const isFloatDebit = op === "debit" && walletBucket === "float";
    const isAdvanceReversalClawback =
      op === "debit" &&
      !isFloatDebit &&
      typeof sub_category === "string" &&
      sub_category.startsWith("advance_reversal:");
    const solvencyRule = isFloatDebit
      ? "float_strict"
      : isAdvanceReversalClawback
        ? "advance_reversal_strict"
        : "withdrawable_strict";
    const validationMethod = isFloatDebit
      ? "get_user_float_available_balance"
      : isAdvanceReversalClawback
        ? "get_user_advance_reversal_available"
        : "get_user_available_balance";

    let bucketBefore: number | null = null;

    if (op === "debit" && (isFloatDebit || !allowOverdraw)) {
      try {
        const { data: availData, error: availErr } = await adminClient.rpc(
          validationMethod,
          { p_user_id: walletUserId },
        );
        if (availErr) {
          console.error(
            `[cfo-direct-credit] ${validationMethod} failed:`,
            availErr.message,
          );
        } else {
          const available = Number(availData ?? 0);
          bucketBefore = available;
          if (available < amount) {
            const shortfall = amount - available;
            const code = isFloatDebit
              ? "FLOAT_INSUFFICIENT_BALANCE"
              : "WITHDRAWABLE_INSUFFICIENT_BALANCE";
            return new Response(
              JSON.stringify({
                error: isFloatDebit
                  ? `${code}: strict operational float balance is ${available}, ` +
                    `requested ${amount}, shortfall ${shortfall}. ` +
                    `Float corrections cannot exceed the wallet's current float — ` +
                    `no personal debt may be created for an operational float shortfall.`
                  : `${code}: strict available balance is ${available}, ` +
                    `requested ${amount}, shortfall ${shortfall}. ` +
                    `Enable Forced Reversal (allow_overdraw) to create a recoverable debt.`,
                code,
                wallet_bucket: walletBucket,
                solvency_rule: solvencyRule,
                validation_method: validationMethod,
                available_balance: available,
                requested_amount: amount,
                shortfall,
              }),
              {
                status: 422,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              },
            );
          }
        }
      } catch (gateErr) {
        console.error(
          "[cfo-direct-credit] solvency gate exception:",
          (gateErr as Error).message,
        );
      }
    }

    const groupId = crypto.randomUUID();

    // Generate trackable PAY- reference (same format COO uses) for every CFO direct credit/debit
    const refId = `PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    // ── Phase 6: evidenced, authorized correction record (DB-enforced) ─────
    // `general_ledger` refuses any `cfo_direct_credit` leg whose reference_id
    // has no matching row here. The row itself is role-gated, self-authorship
    // blocked, evidence-floored (>= 20 chars) and immutable at the DB level —
    // the identical shape used for merchant_float_reconciliations.
    {
      const { error: corrErr } = await adminClient
        .from("platform_wallet_corrections")
        .insert({
          tool: "cfo_direct_credit",
          operation: op === "debit" ? "debit" : "credit",
          target_user_id,
          amount,
          evidence: `CFO Direct ${op === "debit" ? "Debit" : "Credit"} [${category_label || wallet_category || ""}]: ${reason}`.trim(),
          reference_id: refId,
          created_by: userId,
          system_authored: isSystemAuthored,
          metadata: {
            wallet_category,
            platform_category,
            category_label: category_label || null,
            sub_category: sub_category || null,
            recipient_type,
            caller_roles: callerRoles,
          },
        });
      if (corrErr) {
        console.error("[cfo-direct-credit] correction record insert failed:", corrErr.message);
        return new Response(JSON.stringify({ error: corrErr.message }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // ── Server-side idempotency guard for email-origin credits ────────────
    // For any credit that carries a gmail_message_id or email_tid we INSERT
    // a row into email_credit_idempotency *before* posting to the ledger.
    // The table has unique indexes on (gmail_message_id, target_user_id) and
    // (email_tid, target_user_id) so a duplicate attempt — even one that
    // bypassed the client pre-flight — fails fast with HTTP 409 and never
    // creates a second ledger entry. This is the authoritative duplicate
    // gate; the client `verify-email-credit-status` call is advisory.
    if (isEmailOriginGuarded) {
      const { error: idemErr } = await adminClient
        .from("email_credit_idempotency")
        .insert({
          gmail_transaction_id: gmailTxId,
          gmail_message_id: effectiveGmailMsgId,
          email_tid: emailTid,
          target_user_id,
          amount,
          operation: op,
          reference_id: refId,
          created_by: userId,
        });
      if (idemErr) {
        const msg = String(idemErr.message || "");
        const isDup = (idemErr as any).code === "23505" || /duplicate key|unique/i.test(msg);
        if (isDup) {
          console.warn(
            "[cfo-direct-credit] DUPLICATE_EMAIL_CREDIT blocked",
            { gmailMsgId, emailTid, target_user_id, amount },
          );
          return new Response(JSON.stringify({
            error: "DUPLICATE_EMAIL_CREDIT: this email / transaction reference has already been credited to this user.",
            reason: "DUPLICATE_EMAIL_CREDIT",
            gmail_message_id: gmailMsgId,
            email_tid: emailTid,
            target_user_id,
          }), {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        console.error("[cfo-direct-credit] idempotency insert error:", msg);
        throw new Error(`Idempotency guard error: ${msg}`);
      }
    }

    if (op === "credit") {
      console.log("[cfo-direct-credit] Creating CREDIT ledger entries for", walletUserId, "amount:", amount, "partner:", target_user_id, "managedProxy:", !!managedProxy);
      const { error: rpcErr } = await adminClient.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: walletUserId,
            amount,
            direction: 'cash_in',
            category: walletCat,
            ledger_scope: 'wallet',
            recipient_type,
            wallet_bucket: walletBucket,
            routing_source: routingSource,
            source_table: 'cfo_direct_credit',
            reference_id: refId,
            description: managedProxy
              ? `Welile Technologies Finance [${category_label || walletCat}] → proxy agent wallet for ${targetProfile.full_name || target_user_id}: ${reason}`
              : `Welile Technologies Finance [${category_label || walletCat}]${sub_category ? ' → ' + sub_category : ''}: ${reason}`,
            currency: 'UGX',
            linked_party: managedProxy ? target_user_id : undefined,
            transaction_date: new Date().toISOString(),
          },
          {
            user_id: userId,
            direction: 'cash_out',
            amount,
            category: platformCat,
            ledger_scope: 'platform',
            source_table: 'cfo_direct_credit',
            reference_id: refId,
            description: `Welile Technologies Finance → ${targetProfile.full_name} [${impact}]: ${reason}`,
            currency: 'UGX',
            transaction_date: new Date().toISOString(),
            ...(platformCashOutNeedsSolvencyBypassReason
              ? { solvency_bypass_reason: solvencyBypassReason }
              : {}),
          },
        ],
        skip_balance_check: true,
      });
      if (rpcErr) {
        console.error("[cfo-direct-credit] Credit ledger error:", rpcErr.message);
        // Roll back the idempotency reservation so the caller can legitimately retry.
        if (isEmailOriginGuarded) {
          await adminClient
            .from("email_credit_idempotency")
            .delete()
            .eq("reference_id", refId);
        }
        throw new Error(`Ledger error: ${rpcErr.message}`);
      }

      // NOTE: CFO "Agent Float Allocation" funds ONLY the agent's rent-collection
      // float (wallet float bucket). It intentionally does NOT touch
      // `agent_landlord_float` — that ring-fenced landlord-payout pool is funded
      // exclusively via the dedicated "Landlord Payout Float" flow.
    } else {
      console.log("[cfo-direct-credit] Creating DEBIT ledger entries for", target_user_id, "amount:", amount);
      const nowIso = new Date().toISOString();
      const entries: any[] = [
        {
          user_id: target_user_id,
          amount,
          direction: 'cash_out',
          category: walletCat,
          ledger_scope: 'wallet',
          recipient_type,
          wallet_bucket: walletBucket,
          routing_source: routingSource,
          source_table: 'cfo_direct_credit',
          reference_id: refId,
          // Required by enforce_no_negative_wallet_ledger to identify the
          // narrow advance-reversal exception while withdrawals are paused.
          // Previously this only lived on platform_wallet_corrections metadata,
          // so the ledger trigger saw NULL and incorrectly used the normal
          // strict-available balance (zero for locked advance funds).
          sub_category: sub_category || undefined,
          description: `${allowOverdraw ? 'CFO Forced Reversal' : 'CFO Debit'} [${category_label || walletCat}]: ${reason}`,
          currency: 'UGX',
          transaction_date: nowIso,
          // Forced reversal bypasses the strict-balance trigger and is
          // hidden from the user-facing ledger view (admin_correction is
          // explicitly excluded by every end-user wallet filter), while
          // still being captured in CFO/ops dashboards and in the
          // cfo_debit_obligations recoverable below.
          ...(walletDebitNeedsSolvencyBypassReason
            ? {
                ...(allowOverdraw ? { classification: 'admin_correction' } : {}),
                solvency_bypass_reason: solvencyBypassReason,
              }
            : {}),
        },
        {
          user_id: userId,
          direction: 'cash_in',
          amount,
          category: platformCat,
          ledger_scope: 'platform',
          source_table: 'cfo_direct_credit',
          reference_id: refId,
          sub_category: sub_category || undefined,
          description: `${targetProfile.full_name} → Platform [${impact}]: ${reason}`,
          currency: 'UGX',
          transaction_date: nowIso,
        },
      ];

      const { error: rpcErr } = await adminClient.rpc('create_ledger_transaction', {
        entries,
        skip_balance_check: true,
      });
      if (rpcErr) {
        console.error("[cfo-direct-credit] Debit ledger error:", rpcErr.message);
        // Roll back the idempotency reservation so a failed debit can be
        // legitimately retried (mirrors the credit branch above).
        if (isEmailOriginGuarded) {
          await adminClient
            .from("email_credit_idempotency")
            .delete()
            .eq("reference_id", refId);
        }
        throw new Error(`Ledger error: ${rpcErr.message}`);
      }

      // Fix 3 (Float Permanent Fix Plan): every CFO debit must leave a
      // traceable liability. The ledger leg alone is invisible to recovery
      // workflows, so we record the obligation atomically. auto_recover stays
      // false by default — CFO clears manually via reversal or write-off,
      // so future user deposits are NOT silently swallowed.
      const { error: oblErr } = await adminClient
        .from('cfo_debit_obligations')
        .insert({
          user_id: target_user_id,
          amount,
          reason,
          created_by: user.id,
          // Bucket-aware: float obligations are OPERATIONAL shortfalls and are
          // never recoverable from a person's future withdrawable credits.
          // Only withdrawable forced reversals are auto-recoverable.
          auto_recover: isFloatDebit ? false : (allowOverdraw ? true : false),
          wallet_bucket: walletBucket,
          recovery_source: walletBucket,
          ledger_reference_id: refId,
          ledger_group_id: groupId,
          metadata: {
            wallet_category: walletCat,
            platform_category: platformCat,
            wallet_bucket: walletBucket,
            recovery_source: walletBucket,
            solvency_rule: solvencyRule,
            validation_method: validationMethod,
            bucket_before: bucketBefore,
            bucket_after: bucketBefore === null ? null : bucketBefore - amount,
            recipient_type,
            financial_impact: impact,
            category_label: category_label || walletCat,
            sub_category: sub_category || null,
            forced_reversal: allowOverdraw,
            solvency_bypass_reason: solvencyBypassReason,
          },
        });
      if (oblErr) {
        // Hard fail: a debit without an obligation row is exactly the bug
        // we are eliminating. Surface it instead of silently continuing.
        console.error("[cfo-direct-credit] cfo_debit_obligations insert failed:", oblErr.message);
        throw new Error(`Obligation record error: ${oblErr.message}`);
      }
    }

    // Audit log
    await adminClient.from("audit_logs").insert({
      user_id: user.id,
      action_type: `cfo_direct_${op}`,
      table_name: "general_ledger",
      record_id: groupId,
      metadata: {
        target_user_id,
        target_name: targetProfile.full_name,
        wallet_user_id: walletUserId,
        managed_proxy_agent_id: managedProxy?.agentId ?? null,
        amount,
        reason,
        operation: op,
        wallet_category: walletCat,
        platform_category: platformCat,
        financial_impact: impact,
        category_label: category_label || walletCat,
        sub_category: sub_category || null,
        reference_id: refId,
        recipient_type,
        routing_version: 'v2',
        wallet_bucket: walletBucket,
        recovery_source: op === 'debit' ? walletBucket : null,
        solvency_rule: op === 'debit' ? solvencyRule : null,
        validation_method: op === 'debit' ? validationMethod : null,
        bucket_before: op === 'debit' ? bucketBefore : null,
        bucket_after: op === 'debit' && bucketBefore !== null ? bucketBefore - amount : null,
        correction_class: op === 'debit'
          ? (walletBucket === 'float' ? 'operational_float_correction' : 'personal_recoverable_debit')
          : null,
        solvency_bypass_reason: solvencyBypassReason,
      },
    });

    // ── Payroll Growth Bonus tracker ──────────────────────────────────────
    // When CFO credits a user for payroll, register the deposit so the daily
    // 0.5% growth job can compound un-withdrawn payroll. Only credits to a
    // real user (not operational_wallet) qualify.
    if (op === "credit" && platformCat === "payroll_expense" && recipient_type === "user") {
      const { error: pgbErr } = await adminClient.from("payroll_growth_balances").insert({
        user_id: target_user_id,
        original_amount: amount,
        current_balance: amount,
        accrued_growth: 0,
        daily_rate: 0.005,
        source_reference_id: refId,
        last_growth_at: new Date().toISOString(),
        status: "active",
      });
      if (pgbErr) {
        console.error("[cfo-direct-credit] payroll_growth_balances insert failed:", pgbErr.message);
      } else {
        console.log("[cfo-direct-credit] Payroll growth tracker created for", target_user_id, "amount:", amount);
      }
    }

    const verb = op === "credit" ? "credited to" : "debited from";

    // Force wallet bucket reconciliation so CFO-credited funds land in the
    // withdrawable bucket immediately (no drift between ledger and wallet columns).
    let newWithdrawableBalance: number | null = null;
    try {
      await adminClient.rpc("reconcile_wallet_from_ledger", { p_user_id: walletUserId });
      // Wallet Routing v2: enforce the operator's recipient_type choice on top
      // of the legacy category-based routing. This guarantees that, regardless
      // of category, money sent to a "user" lands in withdrawable_balance and
      // money sent to an "operational_wallet" lands in float_balance.
      const { error: enforceErr } = await adminClient.rpc("enforce_recipient_routing", {
        p_user_id: walletUserId,
        p_amount: amount,
        p_recipient_type: recipient_type,
      });
      if (enforceErr) {
        console.error("[cfo-direct-credit] enforce_recipient_routing failed:", enforceErr.message);
      }
      const { data: refreshed } = await adminClient
        .from("wallets")
        .select("withdrawable_balance")
        .eq("user_id", walletUserId)
        .single();
      newWithdrawableBalance = Number(refreshed?.withdrawable_balance ?? 0);
    } catch (reconErr) {
      console.error("[cfo-direct-credit] reconcile_wallet_from_ledger failed:", (reconErr as Error).message);
    }

    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({ title: "💳 Welile Technologies Finance", body: "Activity: wallet credit", url: "/dashboard/manager" }),
    }).catch(() => {});

    // Push notification to target user (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${serviceKey}` },
      body: JSON.stringify({
        userIds: [target_user_id],
        payload: { title: op === "credit" ? "💰 Welile Technologies Finance" : "💸 Wallet Debited", body: `UGX ${amount.toLocaleString()} ${verb} your wallet by Welile Technologies Finance`, url: "/dashboard/funder", type: "success" },
      }),
    }).catch(() => {});

    // ── Recipient SMS alert (fire-and-forget) ───────────────────────────
    // Notify the user by text whenever the CFO sends money to their wallet.
    if (op === "credit" && targetProfile.phone) {
      const smsMsg =
        `WELILE: UGX ${amount.toLocaleString()} has been sent to your wallet ` +
        `by Welile Technologies Finance. Ref: ${refId}. Thank you.`;
      // IMPORTANT: await the SMS. A fire-and-forget promise gets killed when the
      // edge isolate tears down right after the response is returned, so the
      // text never reaches Africa's Talking. Awaiting guarantees instant delivery.
      try {
        const sent = await sendSMS(targetProfile.phone, smsMsg, {
          recipientUserId: target_user_id,
          recipientName: targetProfile.full_name ?? null,
          referenceId: refId,
          source: "cfo-direct-credit",
        });
        console.log(`[cfo-direct-credit] recipient SMS to ${targetProfile.phone}: ${sent ? "sent" : "failed"} ref=${refId}`);
      } catch (e) {
        console.error("[cfo-direct-credit] recipient SMS failed:", (e as Error).message);
      }
    }

    // ── Learn the depositor's number (manual Financial Ops routing) ──────
    // Done inside the edge function so an operator can never skip it. Linking
    // happens only after this POSITIVE identification, is idempotent, and never
    // overwrites a number already owned by a different user (that case is
    // flagged for review instead).
    if (op === "credit" && sourcePhoneLast9) {
      const learned = await learnDepositNumber(adminClient, {
        userId: target_user_id,
        phone: sourcePhoneLast9,
        source: "manual_route",
        gmailTransactionId: gmailTxId,
        createdBy: userId,
        notes: `manual route ref=${refId}`,
      });
      // One-time nudge: only on the FIRST time this number is linked.
      if (learned.outcome === "linked" && targetProfile.phone) {
        const msg =
          `Welile: your deposit of UGX ${amount.toLocaleString()} was credited. ` +
          `It came from a number not on your account - we've linked it so future ` +
          `deposits from it are recognized automatically. For instant crediting, ` +
          `prefer your registered number.`;
        try {
          await sendSMS(targetProfile.phone, msg, {
            recipientUserId: target_user_id,
            recipientName: targetProfile.full_name ?? null,
            referenceId: refId,
            source: "cfo-direct-credit-number-linked",
          });
        } catch (e) {
          console.error("[cfo-direct-credit] number-linked SMS failed:", (e as Error).message);
        }
      }
    }

    // ── Learn the depositor's NAME (manual Financial Ops routing) ────────
    // MTN till/merchant "received" SMS never carries a phone — only whatever
    // name is on the payer's SIM. This is the name-keyed counterpart of the
    // phone-learning block above: once a human has confirmed "this name pays
    // on behalf of this user", the next receipt from that exact name
    // auto-credits instantly instead of waiting for another manual route.
    // Names collide far more than phone numbers, so learnDepositName freezes
    // (never guesses) the moment the same name is ever linked to a second,
    // different user.
    if (op === "credit" && sourceName) {
      await learnDepositName(adminClient, {
        userId: target_user_id,
        name: sourceName,
        source: "manual_route",
        gmailTransactionId: gmailTxId,
        createdBy: userId,
        notes: `manual route ref=${refId}`,
      });
    }

    // ── Send Partner Wallet Deposit email on ROI payouts (mirrors approve-wallet-operation) ──
    if (op === "credit" && (walletCat === "roi_wallet_credit" || platformCat === "roi_expense")) {
      try {
        if (targetProfile.email) {
          // Suppress this email for proxy partners — they receive the
          // "Returns Disbursement Confirmation" email at withdrawal time
          // instead. Sending both is redundant and confusing.
          const { data: proxyAssignment } = await adminClient
            .from("proxy_agent_assignments")
            .select("id")
            .eq("beneficiary_id", target_user_id)
            .eq("beneficiary_role", "supporter")
            .eq("is_active", true)
            .eq("approval_status", "approved")
            .maybeSingle();
          if (proxyAssignment) {
            console.log(`[cfo-direct-credit] Skipping partner-wallet-deposit email — ${target_user_id} is a proxy partner (assignment=${proxyAssignment.id}); disbursement email will be sent on withdrawal.`);
          } else {
          const { data: partnerWallet } = await adminClient
            .from("wallets")
            .select("id")
            .eq("user_id", target_user_id)
            .maybeSingle();
          const walletLast4 = partnerWallet?.id
            ? partnerWallet.id.replace(/-/g, "").slice(-4)
            : "";

          const todayLabel = new Date().toLocaleDateString("en-GB", {
            day: "2-digit", month: "long", year: "numeric",
          });

          await fetch(`${supabaseUrl}/functions/v1/send-transactional-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              templateName: "partner-wallet-deposit",
              recipientEmail: targetProfile.email,
              idempotencyKey: `partner-wallet-deposit-cfo-${groupId}`,
              templateData: {
                partner_name: targetProfile.full_name || "Partner",
                transaction_id: refId,
                amount,
                currency: "UGX",
                date: todayLabel,
                wallet_id_last4: walletLast4,
                source: "Platform",
                company_name: "Welile",
                logo_url: "https://welileapp.com/welile-logo.png",
              },
            }),
          });
          console.log(`[cfo-direct-credit] Partner wallet deposit email queued for ${target_user_id} ref=${refId}`);
          }
        } else {
          console.warn(`[cfo-direct-credit] Skipping partner deposit email - no email for ${target_user_id}`);
        }
      } catch (emailErr) {
        console.warn(`[cfo-direct-credit] Partner deposit email failed:`, (emailErr as Error).message);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `UGX ${amount.toLocaleString()} ${verb} ${targetProfile.full_name}`,
      new_withdrawable_balance: newWithdrawableBalance,
      reference_id: refId,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (e) {
    console.error("[cfo-direct-credit] Error:", e.message);
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
