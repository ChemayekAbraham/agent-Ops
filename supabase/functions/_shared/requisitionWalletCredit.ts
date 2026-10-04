/**
 * Shared requisition -> wallet credit engine.
 *
 * Guarantees:
 *  - only APPROVED requisitions are credited
 *  - a requisition can be credited exactly once (unique row in
 *    public.requisition_wallet_credits acts as the idempotency lock)
 *  - a failed credit leaves a retryable `failed` row, never a duplicate credit
 *  - every credit posts a full double-entry ledger transaction through
 *    cfo-direct-credit (recipient_type: 'user' -> withdrawable bucket)
 */
import { sendSMS } from "./sendSmsMultiProvider.ts";
import { maySendRequisitionSms } from "./requisitionSmsPolicy.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

export interface RequisitionCreditInput {
  admin: Admin;
  sourceTable: "director_requisitions" | "employee_requisitions" | "staff_requisitions";
  requisitionId: string;
  requisitionCode: string;
  userId: string;            // requester (never the approver)
  approverId: string | null;
  approverName?: string | null;
  amount: number;
  currency?: string;
  purpose: string;
  category?: string | null;
  status: string;            // current requisition status, must be 'approved'
  approvedAt?: string | null;
  ipAddress?: string | null;
  deviceInfo?: string | null;
}

export interface RequisitionCreditResult {
  ok: boolean;
  already_credited?: boolean;
  wallet_transaction_id?: string | null;
  message: string;
  error?: string;
  /** Upstream function that failed, e.g. "cfo-direct-credit". */
  upstream_function?: string | null;
  /** Upstream HTTP status code, when the failure came from an HTTP hop. */
  upstream_status?: number | null;
  /** Machine-readable stage for the operator UI. */
  stage?: string | null;
  attempt_count?: number | null;
  idempotency_reference?: string | null;
}

function fmtUGX(n: number) {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

/**
 * Runs a best-effort side effect (logging, notifications) and swallows any
 * failure. PostgREST query builders are thenables WITHOUT a `.catch()` method,
 * so `builder.catch(...)` throws a TypeError — which, inside an error handler,
 * masks the original failure. Always route best-effort writes through this.
 */
async function safe(label: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[requisition-wallet-credit] ${label} failed (non-fatal):`, (e as Error)?.message ?? e);
  }
}

async function logAuditEvent(
  admin: Admin,
  args: {
    actionType: string;
    sourceTable: string;
    requisitionId: string;
    approverId: string | null;
    reason: string;
    metadata: Record<string, unknown>;
  },
) {
  await safe(`audit ${args.actionType}`, () =>
    admin.from("audit_logs").insert({
      user_id: args.approverId,
      action_type: args.actionType,
      table_name: args.sourceTable,
      record_id: args.requisitionId,
      reason: (args.reason || "Requisition wallet credit event").slice(0, 300),
      metadata: args.metadata,
    }));
}

export async function creditRequisitionWallet(
  input: RequisitionCreditInput,
): Promise<RequisitionCreditResult> {
  const {
    admin, sourceTable, requisitionId, requisitionCode, userId, approverId,
    approverName, purpose, category, status, approvedAt, ipAddress, deviceInfo,
  } = input;
  const amount = Math.round(Number(input.amount) * 100) / 100;
  const currency = input.currency || "UGX";
  const idempotencyReference = `${sourceTable}:${requisitionId}`;

  // 5. Validation — only approved requisitions may be credited.
  if (status !== "approved") {
    return { ok: false, stage: "validation", message: `Requisition is ${status}; only approved requisitions can be credited.`, error: "not_approved" };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, stage: "validation", message: "Invalid requisition amount.", error: "invalid_amount" };
  }
  if (!userId) {
    return { ok: false, stage: "validation", message: "No requester account is linked to this requisition.", error: "no_recipient" };
  }

  // 7. Audit trail — approval started.
  await logAuditEvent(admin, {
    actionType: "requisition_wallet_credit_started",
    sourceTable, requisitionId, approverId,
    reason: `Wallet credit started for ${requisitionCode} (${fmtUGX(amount)})`,
    metadata: {
      requisition_id: requisitionId, requisition_code: requisitionCode, amount, currency,
      user_id: userId, approver_id: approverId, approver_name: approverName,
      idempotency_reference: idempotencyReference, ip_address: ipAddress, device_info: deviceInfo,
      at: new Date().toISOString(),
    },
  });

  // Wallet must exist for the requester.
  const { data: wallet } = await admin.from("wallets").select("user_id").eq("user_id", userId).maybeSingle();
  if (!wallet) {
    await recordFailure(admin, input, "Wallet not found for requester");
    return { ok: false, stage: "wallet_lookup", message: "This user has no Welile Wallet yet, so the credit was not processed.", error: "wallet_missing" };
  }

  // 4. Idempotency lock — unique (source_table, requisition_id).
  const { data: lock, error: lockErr } = await admin
    .from("requisition_wallet_credits")
    .insert({
      source_table: sourceTable,
      requisition_id: requisitionId,
      requisition_code: requisitionCode,
      user_id: userId,
      approver_id: approverId,
      amount,
      currency,
      status: "pending",
      approved_at: approvedAt ?? new Date().toISOString(),
      ip_address: ipAddress ?? null,
      device_info: deviceInfo ?? null,
      metadata: { purpose, category },
    })
    .select("id, status, wallet_transaction_id")
    .maybeSingle();

  let creditRowId: string | null = lock?.id ?? null;
  let attemptCount = 1;

  if (lockErr) {
    const msg = String(lockErr.message || "");
    if (!msg.includes("duplicate key") && !msg.includes("requisition_wallet_credits_unique")) {
      return { ok: false, stage: "idempotency_lock", message: "Could not start the wallet credit.", error: msg };
    }
    const { data: existing } = await admin
      .from("requisition_wallet_credits")
      .select("id, status, wallet_transaction_id, attempt_count")
      .eq("source_table", sourceTable)
      .eq("requisition_id", requisitionId)
      .maybeSingle();

    if (existing?.status === "credited") {
      return {
        ok: true,
        already_credited: true,
        stage: "already_credited",
        wallet_transaction_id: existing.wallet_transaction_id,
        idempotency_reference: idempotencyReference,
        message: "This requisition has already been credited to the wallet. No further funding was processed.",
      };
    }
    // pending or failed -> retry this same row, never a second one.
    creditRowId = existing?.id ?? null;
    attemptCount = (existing?.attempt_count ?? 1) + 1;
    await admin.from("requisition_wallet_credits")
      .update({ status: "pending", error_message: null, attempt_count: attemptCount, approver_id: approverId })
      .eq("id", creditRowId);
  }

  // 2 + 3. Wallet credit + double-entry ledger transaction.
  //
  // Server-to-server hop: cfo-direct-credit requires an Authorization header.
  // `admin.functions.invoke()` attaches NO header for a session-less
  // service-role client, which is why this used to fail with 401. Use the
  // project's standard raw-fetch pattern with the service-role bearer.
  let walletTxId: string | null = null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  let upstreamStatus: number | null = null;

  await logAuditEvent(admin, {
    actionType: "requisition_wallet_credit_attempt",
    sourceTable, requisitionId, approverId,
    reason: `Wallet credit attempt #${attemptCount} for ${requisitionCode}`,
    metadata: {
      requisition_id: requisitionId, requisition_code: requisitionCode, amount,
      upstream_function: "cfo-direct-credit", retry_count: attemptCount - 1,
      idempotency_reference: idempotencyReference, approver_id: approverId,
      at: new Date().toISOString(),
    },
  });

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/cfo-direct-credit`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        apikey: serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system_requisition_credit: true,
        target_user_id: userId,
        amount,
        operation: "credit",
        recipient_type: "user",
        wallet_category: "payroll_expense",
        platform_category: "payroll_expense",
        financial_impact: "expense",
        category_label: "Requisition Credit",
        sub_category: category || "requisition",
        reason: `Requisition ${requisitionCode}: ${purpose}`,
        manual_credit: true,
      }),
    });
    upstreamStatus = res.status;
    const raw = await res.text();
    let cc: { error?: string; message?: string; reference_id?: string } = {};
    try { cc = raw ? JSON.parse(raw) : {}; } catch { cc = { error: raw.slice(0, 300) }; }
    if (!res.ok || cc?.error) {
      throw new Error(cc?.error || cc?.message || `cfo-direct-credit returned HTTP ${res.status}`);
    }
    walletTxId = cc?.reference_id ?? null;
  } catch (e) {
    const message = String((e as Error).message ?? e);
    // Every recovery write is best-effort and MUST NOT throw a second error
    // that masks the real upstream failure.
    await safe("mark credit row failed", () =>
      admin.from("requisition_wallet_credits")
        .update({ status: "failed", error_message: `${upstreamStatus ? `HTTP ${upstreamStatus}: ` : ""}${message}`.slice(0, 500) })
        .eq("id", creditRowId));
    await safe("mark requisition failed", () =>
      admin.from(sourceTable).update({ wallet_credit_status: "failed" }).eq("id", requisitionId));
    await safe("notify admins", () => notifyAdminsOfFailure(admin, requisitionCode, amount, message));
    await logAuditEvent(admin, {
      actionType: "requisition_wallet_credit_failed",
      sourceTable, requisitionId, approverId,
      reason: message.slice(0, 200) || "Wallet credit failed",
      metadata: {
        requisition_id: requisitionId, requisition_code: requisitionCode, amount,
        user_id: userId, approver_id: approverId, approver_name: approverName,
        upstream_function: "cfo-direct-credit", upstream_status: upstreamStatus,
        upstream_error: message, retry_count: attemptCount - 1,
        idempotency_reference: idempotencyReference,
        ip_address: ipAddress, device_info: deviceInfo, at: new Date().toISOString(),
      },
    });
    return {
      ok: false,
      stage: "wallet_credit",
      upstream_function: "cfo-direct-credit",
      upstream_status: upstreamStatus,
      attempt_count: attemptCount,
      idempotency_reference: idempotencyReference,
      message: `Approved — wallet credit failed (${upstreamStatus ?? "no response"}): ${message}. The credit can be retried safely.`,
      error: message,
    };
  }

  const creditedAt = new Date().toISOString();
  await admin.from("requisition_wallet_credits")
    .update({ status: "credited", wallet_transaction_id: walletTxId, credited_at: creditedAt, error_message: null })
    .eq("id", creditRowId);
  await admin.from(sourceTable)
    .update({
      wallet_credit_status: "credited",
      wallet_transaction_id: walletTxId,
      credited_at: creditedAt,
      credited_by: approverId,
    })
    .eq("id", requisitionId);

  // 7. Audit trail.
  await logAuditEvent(admin, {
    actionType: "requisition_wallet_credited",
    sourceTable, requisitionId, approverId,
    reason: `Requisition ${requisitionCode} credited ${fmtUGX(amount)}`,
    metadata: {
      requisition_id: requisitionId,
      requisition_code: requisitionCode,
      wallet_transaction_id: walletTxId,
      user_id: userId,
      approver_id: approverId,
      approver_name: approverName,
      amount,
      currency,
      approved_at: approvedAt,
      credited_at: creditedAt,
      upstream_function: "cfo-direct-credit",
      upstream_status: upstreamStatus,
      retry_count: attemptCount - 1,
      idempotency_reference: idempotencyReference,
      ip_address: ipAddress,
      device_info: deviceInfo,
    },
  });

  // 6. Notifications (best-effort, never roll back a posted credit).
  const message = `Your requisition has been approved and ${fmtUGX(amount)} has been credited to your Welile Wallet.`;
  const { data: profile } = await admin.from("profiles").select("full_name, phone, email").eq("id", userId).maybeSingle();

  await safe("recipient notification", () =>
    admin.from("notifications").insert({
      user_id: userId,
      type: "requisition_wallet_credit",
      title: `Requisition ${requisitionCode} funded`,
      message,
      metadata: { requisition_id: requisitionId, wallet_transaction_id: walletTxId, amount },
    }));

  const mayNotify = await maySendRequisitionSms(admin, userId);

  if (profile?.email && mayNotify) {
    await safe("recipient email", () =>
      fetch(`${supabaseUrl}/functions/v1/send-email`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          apikey: serviceKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: profile.email,
          subject: `Requisition ${requisitionCode} — wallet credited`,
          html: `<p>Hello ${profile.full_name || "there"},</p><p>${message}</p><p>Reference: <b>${walletTxId ?? requisitionCode}</b></p>`,
        }),
      }));
  }

  if (profile?.phone && mayNotify) {
    await safe("recipient SMS", () =>
      sendSMS(profile.phone, `Welile: ${message}`, {
        admin,
        source: "requisition-wallet-credit",
        reference_id: requisitionId,
        recipient_user_id: userId,
        recipient_name: profile.full_name,
        idempotencyKey: `req-credit-${sourceTable}-${requisitionId}`,
      }));
  }

  return {
    ok: true,
    stage: "credited",
    wallet_transaction_id: walletTxId,
    upstream_function: "cfo-direct-credit",
    upstream_status: upstreamStatus,
    attempt_count: attemptCount,
    idempotency_reference: idempotencyReference,
    message,
  };
}

async function recordFailure(admin: Admin, input: RequisitionCreditInput, message: string) {
  await safe("record failure row", () =>
    admin.from("requisition_wallet_credits").upsert({
      source_table: input.sourceTable,
      requisition_id: input.requisitionId,
      requisition_code: input.requisitionCode,
      user_id: input.userId,
      approver_id: input.approverId,
      amount: input.amount,
      currency: input.currency || "UGX",
      status: "failed",
      error_message: message,
      ip_address: input.ipAddress ?? null,
      device_info: input.deviceInfo ?? null,
    }, { onConflict: "source_table,requisition_id" }));
  await safe("mark requisition failed", () =>
    admin.from(input.sourceTable).update({ wallet_credit_status: "failed" }).eq("id", input.requisitionId));
}

async function notifyAdminsOfFailure(admin: Admin, code: string, amount: number, error: string) {
  try {
    const { data: admins } = await admin
      .from("user_roles")
      .select("user_id")
      .in("role", ["cfo", "super_admin"])
      .eq("enabled", true)
      .limit(20);
    for (const a of admins || []) {
      await safe("admin failure notification", () =>
        admin.from("notifications").insert({
          user_id: a.user_id,
          type: "requisition_wallet_credit_failed",
          title: `Wallet credit failed: ${code}`,
          message: `Requisition ${code} (${fmtUGX(amount)}) was approved but the wallet credit failed: ${error}. Retry from the requisitions dashboard.`,
          metadata: { requisition_code: code, amount, error },
        }));
    }
  } catch (_) { /* non-fatal */ }
}
