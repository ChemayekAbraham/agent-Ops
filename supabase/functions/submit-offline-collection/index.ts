// Submit a single agent-local offline collection draft after proof is attached.
//
// Per CFO mandate (mem://business-model/agent-tenant-float-allocation +
// design doc docs/offline-collect-design.md):
//
//   1. Drafts captured offline live ONLY in the agent's IndexedDB until they
//      attach a proof bundle. This function is the ONE-WAY door from
//      "device-local draft" to "real collection visible to Operations".
//   2. We HARD-REJECT anything without a valid proof bundle. No proof = no
//      money movement = no draft acceptance.
//   3. We delegate the actual money movement to the same RPC that the
//      online flow uses (`agent_allocate_tenant_payment`) so offline and
//      online collections are indistinguishable in the ledger.
//   4. We are idempotent on `draft_id` — replays from a flaky network can
//      never double-count cash. We persist the (draft_id → server receipt)
//      mapping in `offline_collection_submissions` so a retry returns the
//      same receipt.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-collection ceiling for offline drafts (UGX). Prevents abuse of the
 *  offline channel for large transfers that should go through the
 *  audited online path. */
const MAX_OFFLINE_AMOUNT = 500_000;

/** Reasonable upper bound on captured-at age. Drafts older than this need
 *  staff review, not a silent server-side accept. */
const MAX_DRAFT_AGE_DAYS = 14;

type ProofType = "transaction_ref" | "photo" | "signature" | "sms_code";
type TxnRefChannel = "mtn_momo" | "airtel_money" | "bank_transfer" | "momo_receipt";

interface ProofBundle {
  type: ProofType;
  channel?: TxnRefChannel;
  reference?: string;
  payer_phone?: string | null;
  photo_data_url?: string;
  signature_data_url?: string;
  sms_code?: string;
  captured_at: string;
}

/** Per-channel reference shape rules. Mirrors the client-side refRules in
 *  AgentPendingSyncDrawer so the server is the source of truth for what
 *  Financial Ops will accept as a verifiable transaction reference. */
const TXN_REF_RULES: Record<TxnRefChannel, RegExp> = {
  mtn_momo: /^[A-Z0-9]{8,20}$/,
  airtel_money: /^[A-Z0-9.]{8,30}$/,
  momo_receipt: /^[A-Z0-9-]{6,30}$/,
  bank_transfer: /^[A-Z0-9-]{6,30}$/,
};

interface SubmitBody {
  draft_id: string;
  tenant_id: string;
  rent_request_id: string;
  amount: number;
  notes?: string | null;
  captured_at: string;
  provisional_receipt_no: string;
  gps_lat?: number | null;
  gps_lng?: number | null;
  gps_accuracy?: number | null;
  proof_bundle: ProofBundle;
}

function bad(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ error: code, message, ...extra }), {
    status,
    headers: jsonHeaders,
  });
}

function isDataUrl(s: unknown, mimePrefix: string): s is string {
  return typeof s === "string"
    && s.startsWith(`data:${mimePrefix}`)
    && s.includes(";base64,");
}

/** Decode a `data:<mime>;base64,<payload>` string into raw bytes + mime. */
function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const commaIdx = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, commaIdx);          // strip "data:"
  const mime = header.split(";")[0] || "application/octet-stream";
  const b64 = dataUrl.slice(commaIdx + 1);
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mime };
}

/** Reject obviously-invalid proof bundles. We do NOT verify the *content*
 *  of the photo/signature here — that's a downstream Ops review concern.
 *  We DO verify shape, size, and that the agent provided the data the
 *  type implies. */
function validateProof(proof: unknown): { ok: true; proof: ProofBundle } | { ok: false; reason: string } {
  if (!proof || typeof proof !== "object") {
    return { ok: false, reason: "Missing proof_bundle" };
  }
  const p = proof as Partial<ProofBundle>;
  if (
    p.type !== "transaction_ref" &&
    p.type !== "photo" &&
    p.type !== "signature" &&
    p.type !== "sms_code"
  ) {
    return { ok: false, reason: "Invalid proof_bundle.type" };
  }
  if (typeof p.captured_at !== "string" || Number.isNaN(Date.parse(p.captured_at))) {
    return { ok: false, reason: "Invalid proof_bundle.captured_at" };
  }

  if (p.type === "transaction_ref") {
    // CFO mandate: the only proof Financial Ops will accept end-to-end is a
    // verifiable wallet/bank transaction reference. Photos/signatures/SMS
    // codes are kept as fallbacks but cannot pass this gate alone.
    const channel = p.channel as TxnRefChannel | undefined;
    if (!channel || !(channel in TXN_REF_RULES)) {
      return { ok: false, reason: "transaction_ref proof requires a valid channel" };
    }
    const ref = typeof p.reference === "string" ? p.reference.trim().toUpperCase() : "";
    if (!ref) {
      return { ok: false, reason: "transaction_ref proof requires a reference" };
    }
    if (!TXN_REF_RULES[channel].test(ref)) {
      return { ok: false, reason: `Reference does not match expected ${channel} format` };
    }
  } else if (p.type === "photo") {
    if (!isDataUrl(p.photo_data_url, "image/")) {
      return { ok: false, reason: "Photo proof requires a base64 image data URL" };
    }
    // 8 MB cap on the base64 payload — the on-device JPEG should be far smaller
    if (p.photo_data_url!.length > 8 * 1024 * 1024) {
      return { ok: false, reason: "Photo proof too large (>8MB base64)" };
    }
  } else if (p.type === "signature") {
    if (!isDataUrl(p.signature_data_url, "image/")) {
      return { ok: false, reason: "Signature proof requires a base64 image data URL" };
    }
    if (p.signature_data_url!.length > 1024 * 1024) {
      return { ok: false, reason: "Signature proof too large (>1MB base64)" };
    }
  } else {
    // sms_code
    if (typeof p.sms_code !== "string" || !/^\d{4,8}$/.test(p.sms_code)) {
      return { ok: false, reason: "SMS code must be 4-8 digits" };
    }
  }

  // Normalise the reference so downstream consumers (Ops queue, ledger
  // notes) see a single canonical form.
  if (p.type === "transaction_ref" && typeof p.reference === "string") {
    p.reference = p.reference.trim().toUpperCase();
  }
  return { ok: true, proof: p as ProofBundle };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return bad(405, "method_not_allowed", "POST required");

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // ── Auth: agent's JWT, validated in-code (project uses signing-keys
    //    so verify_jwt=false at the gateway is the documented pattern).
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return bad(401, "unauthorized", "Missing Authorization header");

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) return bad(401, "unauthorized", "Invalid or expired session");
    const agentId = user.id;

    // ── Parse + shape-validate body
    let body: SubmitBody;
    try {
      body = await req.json();
    } catch {
      return bad(400, "invalid_body", "Body must be valid JSON");
    }

    if (!body.draft_id || !UUID_RE.test(body.draft_id)) {
      return bad(400, "invalid_draft_id", "draft_id must be a UUID");
    }
    if (!body.tenant_id || !UUID_RE.test(body.tenant_id)) {
      return bad(400, "invalid_tenant_id", "tenant_id must be a UUID");
    }
    if (!body.rent_request_id || !UUID_RE.test(body.rent_request_id)) {
      return bad(400, "invalid_rent_request_id", "rent_request_id must be a UUID");
    }
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 100) {
      return bad(400, "invalid_amount", "amount must be a whole UGX number ≥ 100");
    }
    if (amount > MAX_OFFLINE_AMOUNT) {
      return bad(
        400,
        "amount_over_offline_cap",
        `Offline collections are capped at UGX ${MAX_OFFLINE_AMOUNT.toLocaleString()}. Use the online flow.`,
      );
    }
    if (typeof body.captured_at !== "string" || Number.isNaN(Date.parse(body.captured_at))) {
      return bad(400, "invalid_captured_at", "captured_at must be an ISO timestamp");
    }
    const ageMs = Date.now() - Date.parse(body.captured_at);
    if (ageMs < 0) return bad(400, "captured_in_future", "captured_at is in the future");
    if (ageMs > MAX_DRAFT_AGE_DAYS * 86_400_000) {
      return bad(409, "draft_too_old", `Draft older than ${MAX_DRAFT_AGE_DAYS} days. Escalate to Ops.`);
    }
    if (typeof body.provisional_receipt_no !== "string" || body.provisional_receipt_no.length > 32) {
      return bad(400, "invalid_receipt_no", "provisional_receipt_no must be a string ≤32 chars");
    }

    // ── HARD GATE: proof bundle must be present and well-formed. No proof,
    //    no submission. This is the whole point of this function.
    const proofResult = validateProof(body.proof_bundle);
    if (!proofResult.ok) {
      return bad(422, "missing_or_invalid_proof", proofResult.reason);
    }
    const proof = proofResult.proof;

    const admin = createClient(supabaseUrl, serviceKey);

    // ── Idempotency: did we already process this draft_id?
    const { data: existing, error: existingErr } = await admin
      .from("offline_collection_submissions")
      .select("id, server_collection_id, server_receipt_no, status, processed_at")
      .eq("draft_id", body.draft_id)
      .maybeSingle();
    if (existingErr) {
      console.error("[submit-offline-collection] lookup failed", existingErr);
      return bad(500, "lookup_failed", "Could not check for prior submission");
    }
    if (existing && existing.status === "accepted") {
      // Same draft retried → return the same receipt, do nothing else.
      return new Response(
        JSON.stringify({
          success: true,
          idempotent: true,
          server_collection_id: existing.server_collection_id,
          server_receipt_no: existing.server_receipt_no,
          processed_at: existing.processed_at,
        }),
        { status: 200, headers: jsonHeaders },
      );
    }

    // ── Verify the rent request belongs to this agent and is collectible.
    const { data: rr, error: rrErr } = await admin
      .from("rent_requests")
      .select("id, agent_id, tenant_id, total_repayment, amount_repaid, status")
      .eq("id", body.rent_request_id)
      .maybeSingle();
    if (rrErr || !rr) return bad(404, "rent_request_not_found", "Rent request not found");
    if (rr.tenant_id !== body.tenant_id) {
      return bad(409, "tenant_mismatch", "Rent request does not belong to that tenant");
    }
    if (rr.agent_id && rr.agent_id !== agentId) {
      return bad(403, "not_your_assignment", "This rent request is assigned to another agent");
    }
    const outstanding = Number(rr.total_repayment) - Number(rr.amount_repaid);
    if (outstanding <= 0) {
      return bad(409, "already_settled", "Rent already fully paid — nothing to allocate");
    }
    if (amount > outstanding) {
      return bad(409, "amount_exceeds_outstanding", "Amount exceeds outstanding balance", {
        outstanding,
      });
    }

    // ── Reserve a row up-front so concurrent retries serialise on the
    //    unique (draft_id) constraint instead of double-spending.
    const { error: reserveErr } = await admin
      .from("offline_collection_submissions")
      .insert({
        draft_id: body.draft_id,
        agent_id: agentId,
        tenant_id: body.tenant_id,
        rent_request_id: body.rent_request_id,
        amount,
        provisional_receipt_no: body.provisional_receipt_no,
        captured_at: body.captured_at,
        proof_type: proof.type,
        gps_lat: body.gps_lat ?? null,
        gps_lng: body.gps_lng ?? null,
        gps_accuracy: body.gps_accuracy ?? null,
        notes: body.notes?.trim() || null,
        status: "processing",
      });
    if (reserveErr) {
      // unique_violation = a parallel retry won the race; bounce the client
      // so it polls and gets the eventual accepted receipt.
      if ((reserveErr as { code?: string }).code === "23505") {
        return bad(409, "submission_in_progress", "This draft is already being processed; retry shortly.");
      }
      console.error("[submit-offline-collection] reserve failed", reserveErr);
      return bad(500, "reserve_failed", "Could not reserve submission slot");
    }

    // ── Upload proof media (if any). SMS-code proofs have no file.
    let proofPath: string | null = null;
    if (proof.type === "photo" || proof.type === "signature") {
      const dataUrl = proof.type === "photo" ? proof.photo_data_url! : proof.signature_data_url!;
      const { bytes, mime } = decodeDataUrl(dataUrl);
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      proofPath = `${agentId}/${body.draft_id}/${proof.type}.${ext}`;
      const { error: uploadErr } = await admin.storage
        .from("offline-collection-proof")
        .upload(proofPath, bytes, { contentType: mime, upsert: true });
      if (uploadErr) {
        await admin.from("offline_collection_submissions")
          .update({ status: "failed", failure_reason: `proof_upload_failed: ${uploadErr.message}` })
          .eq("draft_id", body.draft_id);
        console.error("[submit-offline-collection] proof upload failed", uploadErr);
        return bad(500, "proof_upload_failed", "Could not store proof media");
      }
    }

    // ── Delegate the actual money movement to the same RPC the online
    //    flow uses. This single call: decrements agent float, credits
    //    landlord, writes ledger entries, inserts agent_collections row.
    const proofTag = proof.type === "transaction_ref"
      ? `proof:txn_ref:${proof.channel}:${proof.reference}`
      : `proof:${proof.type}`;
    const noteSuffix = `[OFFLINE ${body.provisional_receipt_no} · ${proofTag}]`;
    const combinedNotes = body.notes?.trim()
      ? `${body.notes.trim()} ${noteSuffix}`
      : noteSuffix;

    // Keep the caller's verified agent JWT on the money-movement RPC. The
    // public wrapper derives wallet ownership from auth.uid(); using the
    // privileged client here would erase that identity and make offline
    // collections behave differently from the online flow.
    const { data: rpcData, error: rpcErr } = await userClient.rpc("agent_allocate_tenant_payment", {
      p_agent_id: agentId,
      p_tenant_id: body.tenant_id,
      p_rent_request_id: body.rent_request_id,
      p_amount: amount,
      p_notes: combinedNotes,
    });

    if (rpcErr || !(rpcData as { success?: boolean })?.success) {
      const message = (rpcData as { error?: string })?.error || rpcErr?.message || "Allocation failed";
      await admin.from("offline_collection_submissions")
        .update({ status: "rejected", failure_reason: message, proof_path: proofPath })
        .eq("draft_id", body.draft_id);
      console.error("[submit-offline-collection] allocation failed", { rpcErr, rpcData });
      // 422 lets the client distinguish "validate-and-retry" (409/422) from
      // "server is broken" (5xx). Float/balance issues are 422.
      return bad(422, "allocation_failed", message, { details: rpcData });
    }

    const result = rpcData as {
      success: boolean;
      collection_id?: string;
      tracking_id?: string;
      commission?: { credited_commission?: number };
    };

    // ── Persist the mapping so retries are idempotent.
    const serverReceiptNo = result.tracking_id || result.collection_id || null;
    const { error: finaliseErr } = await admin
      .from("offline_collection_submissions")
      .update({
        status: "accepted",
        server_collection_id: result.collection_id || null,
        server_receipt_no: serverReceiptNo,
        proof_path: proofPath,
        processed_at: new Date().toISOString(),
      })
      .eq("draft_id", body.draft_id);
    if (finaliseErr) {
      // The money already moved — log loudly but do not fail the response.
      console.error("[submit-offline-collection] finalise update failed (non-fatal)", finaliseErr);
    }

    // Fire-and-forget: email the agent their receipt + capacity report.
    // Never blocks the response.
    try {
      admin.functions
        .invoke("send-agent-payment-receipt-email", {
          body: {
            agent_id: agentId,
            tenant_id: body.tenant_id,
            rent_request_id: body.rent_request_id,
            amount,
            commission: result.commission?.credited_commission ?? 0,
            allocation_id: result.collection_id || result.tracking_id || null,
          },
        })
        .catch((e) => console.warn("[submit-offline-collection] receipt email failed", e));
    } catch (e) {
      console.warn("[submit-offline-collection] receipt email dispatch failed", e);
    }

    return new Response(
      JSON.stringify({
        success: true,
        idempotent: false,
        server_collection_id: result.collection_id,
        server_receipt_no: serverReceiptNo,
        commission_credited: result.commission?.credited_commission ?? 0,
        processed_at: new Date().toISOString(),
      }),
      { status: 200, headers: jsonHeaders },
    );
  } catch (err) {
    console.error("[submit-offline-collection] unhandled", err);
    return bad(500, "internal_error", err instanceof Error ? err.message : "Unknown error");
  }
});