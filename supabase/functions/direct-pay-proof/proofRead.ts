/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * Pure helpers for direct-pay-proof (no network, no Deno APIs), so they can be unit tested.
 * The image reader itself is approve-withdrawal/proofVision.ts, reused as is.
 */
import type { ProofVisionResult } from "../approve-withdrawal/proofVision.ts";

export const BUCKET = "funder-offplatform-receipts";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ProofRequest {
  payment_id: string;
  photo_path: string;
  tid_typed: string | null;
  amount_typed: number | null;
  provider: "mtn" | "airtel" | null;
}

/** What direct_pay_record_proof receives as p_read. Built only from what the server itself read. */
export interface ProofRead {
  status: "read" | "unreadable" | "error";
  tid: string | null;
  amount: number | null;
  phone: string | null;
  paid_at: string | null;
  confidence: "high" | "low" | null;
  reason?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Validates the browser's request. Returns an error code, or the cleaned request. */
export function parseProofRequest(body: unknown, userId: string): { error: string } | { request: ProofRequest } {
  if (!body || typeof body !== "object") return { error: "invalid" };
  const b = body as Record<string, unknown>;
  const paymentId = typeof b.payment_id === "string" ? b.payment_id.trim() : "";
  const path = typeof b.photo_path === "string" ? b.photo_path.trim() : "";
  if (!UUID.test(paymentId)) return { error: "invalid" };
  // The photo must sit in the caller's own folder; no "..", no other bucket.
  if (!path.startsWith(`${userId}/`) || path.includes("..") || path.length > 300) return { error: "invalid_photo" };
  const tid = typeof b.tid_typed === "string" && b.tid_typed.trim() ? b.tid_typed.trim().slice(0, 64) : null;
  const amountNum = typeof b.amount_typed === "number" ? b.amount_typed : Number(b.amount_typed);
  const amount = Number.isFinite(amountNum) && amountNum > 0 ? Math.round(amountNum) : null;
  const provider = b.provider === "mtn" || b.provider === "airtel" ? b.provider : null;
  return { request: { payment_id: paymentId, photo_path: path, tid_typed: tid, amount_typed: amount, provider } };
}

/** SMS screenshots show Kampala time (UTC+3, no daylight saving). */
export function kampalaTimestamp(date: string | null | undefined, time: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const t = time && /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, "0") : null;
  if (!t) return null; // a date alone cannot tell "before the hold" apart; leave it unknown
  const iso = `${date}T${t}:00+03:00`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

export function mimeFromPath(path: string): string {
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  return "image/jpeg";
}

/** Turns the reader's result into p_read. A reader failure is "error"/"unreadable", never a refusal by itself. */
export function toProofRead(result: ProofVisionResult | null, reason?: string): ProofRead {
  const f = result?.fields;
  if (!f) {
    return { status: "error", tid: null, amount: null, phone: null, paid_at: null, confidence: null,
             reason: result?.unverifiableReason ?? reason ?? "not_read" };
  }
  const amount = typeof f.amount === "number" && f.amount > 0 ? f.amount : null;
  return {
    status: amount === null ? "unreadable" : "read",
    tid: f.transactionId?.trim() || null,
    amount,
    phone: f.phone?.trim() || null,
    paid_at: kampalaTimestamp(f.date, f.time),
    confidence: f.confidence ?? null,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64FromBytes(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}
