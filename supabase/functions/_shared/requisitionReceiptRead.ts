/**
 * Download a requisition's own receipt files and record what they say.
 * Does not credit, debit, or reverse a wallet.
 */
import { assessReceiptPayout, type ReceiptVerdict } from "./requisitionReceiptMatch.ts";
import {
  bytesToBase64,
  extractReceiptTotal,
  isUgxCurrency,
  mimeForReceiptPath,
} from "./requisitionReceiptVision.ts";

// deno-lint-ignore no-explicit-any
type Admin = any;

const BUCKET = "requisition-attachments";

export interface ReceiptReadSummary {
  skipped?: boolean;
  verdict: ReceiptVerdict;
}

function missingColumn(error: { message?: string; code?: string } | null | undefined): boolean {
  const msg = `${error?.code ?? ""} ${error?.message ?? ""}`;
  return /42703|PGRST204|requisition_receipt_paths|receipt_match_status|schema cache/i.test(msg);
}

async function logRead(
  admin: Admin,
  requisitionId: string,
  actorId: string | null,
  action: string,
  stage: string | null,
  comment: string,
  metadata: Record<string, unknown>,
) {
  const { error } = await admin.from("staff_requisition_events").insert({
    requisition_id: requisitionId,
    actor_id: actorId,
    action,
    stage,
    comment: comment.slice(0, 300),
    metadata,
  });
  if (error) console.error(`[requisition-receipt] event ${action} failed (non-fatal)`, error.message);
}

/**
 * Remember a file as a requisition receipt (not a usage-report attachment).
 * Clears the previous read so payout cannot ride on a stale total.
 */
export async function rememberRequisitionReceiptPath(
  admin: Admin,
  requisitionId: string,
  path: string,
): Promise<"saved" | "missing_column" | "failed"> {
  const { data: row, error } = await admin
    .from("staff_requisitions")
    .select("requisition_receipt_paths, wallet_credit_status")
    .eq("id", requisitionId)
    .maybeSingle();
  if (error) return missingColumn(error) ? "missing_column" : "failed";
  const existing: string[] = Array.isArray(row?.requisition_receipt_paths) ? row.requisition_receipt_paths : [];
  if (existing.includes(path)) return "saved";
  const { error: upErr } = await admin
    .from("staff_requisitions")
    .update({
      requisition_receipt_paths: [...existing, path],
      receipt_ocr_amount: null,
      receipt_ocr_confidence: null,
      receipt_ocr_currency: null,
      receipt_ocr_at: null,
      receipt_ocr_error: null,
      receipt_ocr_detail: null,
      amount_unaccounted: null,
      approved_amount_unaccounted: null,
      receipt_match_status: "pending",
      payout_frozen: row?.wallet_credit_status === "credited" ? false : true,
      receipt_gap_cleared_at: null,
      receipt_gap_cleared_by: null,
      receipt_gap_clearance_note: null,
      receipt_gap_cleared_typed_amount: null,
      receipt_gap_cleared_ocr_amount: null,
    })
    .eq("id", requisitionId);
  if (upErr) return missingColumn(upErr) ? "missing_column" : "failed";
  return "saved";
}

export async function readStaffRequisitionReceipts(
  admin: Admin,
  requisitionId: string,
  opts: { apiKey?: string; actorId?: string | null },
): Promise<ReceiptReadSummary> {
  const { data: row, error } = await admin
    .from("staff_requisitions")
    .select("*")
    .eq("id", requisitionId)
    .maybeSingle();
  if (error || !row) throw new Error(error?.message || "Requisition not found");
  if (!Object.prototype.hasOwnProperty.call(row, "receipt_match_status")) {
    return { skipped: true, verdict: assessReceiptPayout(row) };
  }

  const paths: string[] = Array.isArray(row.requisition_receipt_paths) ? row.requisition_receipt_paths : [];
  const now = new Date().toISOString();
  if (paths.length === 0) {
    await persist(admin, row, {
      receipt_ocr_amount: null,
      receipt_ocr_confidence: null,
      receipt_ocr_currency: null,
      receipt_ocr_at: null,
      receipt_ocr_error: null,
      receipt_ocr_detail: [],
    });
    const fresh = { ...row, requisition_receipt_paths: [], receipt_ocr_amount: null, receipt_ocr_at: null, receipt_ocr_error: null, receipt_ocr_confidence: null };
    return { verdict: assessReceiptPayout(fresh) };
  }

  const detail: Record<string, unknown>[] = [];
  let failure: string | null = null;
  let sum = 0;
  const apiKey = opts.apiKey ?? "";

  for (const path of paths) {
    const mime = mimeForReceiptPath(path);
    if (mime === "application/octet-stream") {
      failure = failure ?? "unsupported_type";
      detail.push({ path, error: "unsupported_type" });
      continue;
    }
    const { data: file, error: dlErr } = await admin.storage.from(BUCKET).download(path);
    if (dlErr || !file) {
      failure = failure ?? "download_failed";
      detail.push({ path, error: "download_failed" });
      continue;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const vision = await extractReceiptTotal(bytesToBase64(bytes), mime, apiKey);
    const total = vision.fields?.totalAmount ?? null;
    const confidence = vision.fields?.confidence ?? null;
    detail.push({
      path,
      totalAmount: total,
      currency: vision.fields?.currency ?? null,
      confidence,
      error: vision.unverifiableReason ?? null,
    });
    if (
      vision.unverifiableReason
      || confidence !== "high"
      || total == null
      || !isUgxCurrency(vision.fields?.currency)
    ) {
      failure = failure ?? vision.unverifiableReason ?? "low_confidence";
      continue;
    }
    sum += total;
  }

  const facts = failure
    ? {
      receipt_ocr_amount: null,
      receipt_ocr_confidence: null,
      receipt_ocr_currency: null,
      receipt_ocr_at: now,
      receipt_ocr_error: failure.slice(0, 300),
      receipt_ocr_detail: detail,
    }
    : {
      receipt_ocr_amount: sum,
      receipt_ocr_confidence: "high",
      receipt_ocr_currency: "UGX",
      receipt_ocr_at: now,
      receipt_ocr_error: null,
      receipt_ocr_detail: detail,
    };

  const { data: latest } = await admin
    .from("staff_requisitions")
    .select("requisition_receipt_paths")
    .eq("id", requisitionId)
    .maybeSingle();
  const latestPaths: string[] = Array.isArray(latest?.requisition_receipt_paths) ? latest.requisition_receipt_paths : [];
  if (latestPaths.join("\n") !== paths.join("\n")) {
    const pending = assessReceiptPayout({
      ...row,
      requisition_receipt_paths: latestPaths,
      receipt_ocr_amount: null,
      receipt_ocr_at: null,
      receipt_ocr_error: null,
      receipt_ocr_confidence: null,
      receipt_match_status: "pending",
    });
    return { verdict: pending };
  }

  await persist(admin, row, facts);
  const verdict = assessReceiptPayout({ ...row, ...facts, receipt_match_status: row.receipt_match_status ?? "pending" });
  await logRead(
    admin,
    requisitionId,
    opts.actorId ?? null,
    "receipt_read",
    row.stage ?? null,
    verdict.message,
    {
      status: verdict.status,
      amount_unaccounted: verdict.amountUnaccounted,
      receipt_ocr_amount: verdict.ocrAmount,
      payout_frozen: verdict.payoutFrozen,
    },
  );
  return { verdict };
}

async function persist(admin: Admin, row: Record<string, unknown>, facts: Record<string, unknown>) {
  const verdict = assessReceiptPayout({
    ...row,
    ...facts,
    receipt_match_status: (row.receipt_match_status as string | null) ?? "pending",
  });
  const { error } = await admin
    .from("staff_requisitions")
    .update({
      ...facts,
      amount_unaccounted: verdict.amountUnaccounted,
      approved_amount_unaccounted: verdict.approvedUnaccounted,
      receipt_compared_amount: verdict.typedAmount,
      receipt_match_status: verdict.status,
      payout_frozen: verdict.payoutFrozen,
    })
    .eq("id", row.id);
  if (error) throw new Error(error.message);
}

/**
 * Record that the CFO accepts the current gap. Does not move money.
 * The clearance covers this typed amount and this official receipt total only.
 */
export async function clearStaffReceiptGap(
  admin: Admin,
  requisitionId: string,
  actorId: string,
  note: string,
): Promise<{ ok: true; verdict: ReceiptVerdict } | { ok: false; error: string }> {
  const { data: row, error } = await admin
    .from("staff_requisitions")
    .select("*")
    .eq("id", requisitionId)
    .maybeSingle();
  if (error || !row) return { ok: false, error: "Requisition not found" };
  if (!Object.prototype.hasOwnProperty.call(row, "receipt_match_status")) {
    return { ok: false, error: "Receipt matching is not installed yet." };
  }
  if (row.requester_id === actorId) {
    return { ok: false, error: "You cannot clear the receipt gap on your own requisition." };
  }
  const current = assessReceiptPayout(row);
  if (!current.gapOpen) {
    return { ok: true, verdict: current };
  }
  const now = new Date().toISOString();
  const patch = {
    receipt_gap_cleared_at: now,
    receipt_gap_cleared_by: actorId,
    receipt_gap_clearance_note: note.slice(0, 2000),
    receipt_gap_cleared_typed_amount: current.typedAmount,
    receipt_gap_cleared_ocr_amount: current.ocrAmount,
  };
  const verdict = assessReceiptPayout({ ...row, ...patch });
  const { error: upErr } = await admin
    .from("staff_requisitions")
    .update({
      ...patch,
      payout_frozen: verdict.payoutFrozen,
      receipt_match_status: verdict.status,
      amount_unaccounted: verdict.amountUnaccounted,
    })
    .eq("id", requisitionId);
  if (upErr) return { ok: false, error: upErr.message };
  await logRead(admin, requisitionId, actorId, "receipt_gap_cleared", row.stage ?? null, note, {
    amount_unaccounted: verdict.amountUnaccounted,
    receipt_ocr_amount: verdict.ocrAmount,
    typed_amount: verdict.typedAmount,
  });
  return { ok: true, verdict };
}
