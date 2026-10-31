import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_MATCH_TOLERANCE_UGX,
  assessReceiptPayout,
  type ReceiptFacts,
} from "../../supabase/functions/_shared/requisitionReceiptMatch";

function row(extra: ReceiptFacts & Record<string, unknown> = {}): ReceiptFacts {
  return {
    receipt_match_status: "no_receipt",
    requisition_receipt_paths: [],
    amount: 100_000,
    ...extra,
  };
}

describe("staff requisition receipt payout gate", () => {
  it("leaves payout unchanged until the receipt columns exist", () => {
    const verdict = assessReceiptPayout({ amount: 100_000, requisition_receipt_paths: ["a.jpg"] });
    expect(verdict.active).toBe(false);
    expect(verdict.allowed).toBe(true);
    expect(verdict.payoutFrozen).toBe(false);
  });

  it("does not hold a requisition that has no requisition receipt", () => {
    const verdict = assessReceiptPayout(row());
    expect(verdict.status).toBe("no_receipt");
    expect(verdict.allowed).toBe(true);
    expect(verdict.amountUnaccounted).toBeNull();
  });

  it("matches within UGX 100 and still records the signed difference", () => {
    expect(RECEIPT_MATCH_TOLERANCE_UGX).toBe(100);
    const exact = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 100_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
    }));
    expect(exact.status).toBe("matched");
    expect(exact.amountUnaccounted).toBe(0);
    expect(exact.allowed).toBe(true);

    const under = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 99_900,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
    }));
    expect(under.status).toBe("matched");
    expect(under.amountUnaccounted).toBe(100);

    const over = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 100_100,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
    }));
    expect(over.status).toBe("matched");
    expect(over.amountUnaccounted).toBe(-100);
  });

  it("signs partial and mismatch as typed minus receipt and freezes payout", () => {
    const partial = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 40_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
      approved_amount: 90_000,
    }));
    expect(partial.status).toBe("partial");
    expect(partial.amountUnaccounted).toBe(60_000);
    expect(partial.approvedUnaccounted).toBe(50_000);
    expect(partial.payoutFrozen).toBe(true);
    expect(partial.allowed).toBe(false);
    expect(partial.message).toContain("typed minus receipt");

    const mismatch = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 150_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
    }));
    expect(mismatch.status).toBe("mismatch");
    expect(mismatch.amountUnaccounted).toBe(-50_000);
    expect(mismatch.payoutFrozen).toBe(true);
  });

  it("does not let a matching approved amount release a typed-amount gap", () => {
    const verdict = assessReceiptPayout(row({
      amount: 100_000,
      approved_amount: 80_000,
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 80_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
    }));
    expect(verdict.status).toBe("partial");
    expect(verdict.amountUnaccounted).toBe(20_000);
    expect(verdict.payoutFrozen).toBe(true);
  });

  it("freezes when the receipt was not read and does not invent a total", () => {
    const pending = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
    }));
    expect(pending.status).toBe("pending");
    expect(pending.ocrAmount).toBeNull();
    expect(pending.amountUnaccounted).toBeNull();
    expect(pending.payoutFrozen).toBe(true);

    const failed = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_at: "2026-10-29T00:00:00Z",
      receipt_ocr_error: "model_response_not_json",
    }));
    expect(failed.status).toBe("needs_manual_review");
    expect(failed.amountUnaccounted).toBeNull();
    expect(failed.payoutFrozen).toBe(true);
  });

  it("does not treat a low-confidence total as a match", () => {
    const verdict = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 100_000,
      receipt_ocr_confidence: "low",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
    }));
    expect(verdict.status).toBe("needs_manual_review");
    expect(verdict.ocrAmount).toBeNull();
    expect(verdict.payoutFrozen).toBe(true);
  });

  it("lets a CFO clearance release the same typed amount and receipt total", () => {
    const cleared = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 40_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
      receipt_gap_cleared_at: "2026-10-29T01:00:00Z",
      receipt_gap_cleared_typed_amount: 100_000,
      receipt_gap_cleared_ocr_amount: 40_000,
    }));
    expect(cleared.clearanceApplies).toBe(true);
    expect(cleared.allowed).toBe(true);
    expect(cleared.payoutFrozen).toBe(false);
    expect(cleared.amountUnaccounted).toBe(60_000);
    expect(cleared.status).toBe("partial");

    const stale = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 40_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
      receipt_gap_cleared_at: "2026-10-29T01:00:00Z",
      receipt_gap_cleared_typed_amount: 90_000,
      receipt_gap_cleared_ocr_amount: 40_000,
    }));
    expect(stale.clearanceApplies).toBe(false);
    expect(stale.payoutFrozen).toBe(true);
  });

  it("lets the CFO clear an unread receipt without inventing a total", () => {
    const verdict = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.pdf"],
      receipt_ocr_at: "2026-10-29T00:00:00Z",
      receipt_ocr_error: "gateway_error_500",
      receipt_gap_cleared_at: "2026-10-29T01:00:00Z",
      receipt_gap_cleared_typed_amount: 100_000,
      receipt_gap_cleared_ocr_amount: null,
    }));
    expect(verdict.status).toBe("needs_manual_review");
    expect(verdict.ocrAmount).toBeNull();
    expect(verdict.clearanceApplies).toBe(true);
    expect(verdict.allowed).toBe(true);
  });

  it("records a gap after payout without clawing the wallet", () => {
    const verdict = assessReceiptPayout(row({
      requisition_receipt_paths: ["r.jpg"],
      receipt_ocr_amount: 10_000,
      receipt_ocr_confidence: "high",
      receipt_ocr_at: "2026-10-29T00:00:00Z",
      wallet_credit_status: "credited",
    }));
    expect(verdict.alreadyCredited).toBe(true);
    expect(verdict.gapOpen).toBe(true);
    expect(verdict.amountUnaccounted).toBe(90_000);
    expect(verdict.payoutFrozen).toBe(false);
    expect(verdict.allowed).toBe(true);
    expect(verdict.message).toContain("Nothing is taken back");
  });

  it("keeps the SQL draft on the same tolerance and sign", () => {
    const sql = readFileSync("docs/pending-migrations/staff_requisition_receipt_match.sql", "utf8");
    expect(sql).toContain("typed minus receipt");
    expect(sql).toContain("v_typed - v_ocr");
    expect(sql).toContain("<= 100");
    expect(sql).not.toMatch(/general_ledger|cfo-direct-credit|wallet_transactions/i);
  });
});
