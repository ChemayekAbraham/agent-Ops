/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 *
 * direct-pay-proof: a partner who paid a landlord directly (option 2) hands in one SMS screenshot.
 *
 * One round trip from the phone: the app uploads the photo to funder-offplatform-receipts/<uid>/..., then calls
 * this function once with { payment_id, photo_path, tid_typed?, amount_typed?, provider? }.
 * This function reads the image ITSELF (approve-withdrawal's reader, unchanged), hashes it, and calls
 * direct_pay_record_proof as service_role. That RPC is closed to the browser, so a partner can never hand in
 * their own "read" amount or date. A reader failure never blocks: the proof is saved and flagged for Landlord Ops.
 * Returns the partner view from the database (status, amount still due, hold end, proofs); never the flags.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { extractProofFieldsFromImage } from "../approve-withdrawal/proofVision.ts";
import { bearerHasSub, noUserResult } from "../_shared/bearerHasSub.ts";
import {
  BUCKET, MAX_IMAGE_BYTES, READER_TIMEOUT_MS, base64FromBytes, mimeFromPath, parseProofRequest, sha256Hex,
  toProofRead, withTimeout,
} from "./proofRead.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, code: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization");

  const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader ?? "" } },
  });
  const { data: { user }, error: authErr } = await (bearerHasSub(authHeader) ? userClient.auth.getUser() : noUserResult());
  if (authErr || !user) return json({ ok: false, code: "not_signed_in" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, code: "invalid" }, 400);
  }
  const parsed = parseProofRequest(body, user.id);
  if ("error" in parsed) return json({ ok: false, code: parsed.error }, 400);
  const r = parsed.request;

  const admin = createClient(supabaseUrl, serviceKey);

  // The image comes from storage, never from the request body.
  const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(r.photo_path);
  if (dlErr || !blob) return json({ ok: false, code: "photo_not_found" }, 400);
  if (blob.size > MAX_IMAGE_BYTES) return json({ ok: false, code: "photo_too_large" }, 400);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  const apiKey = Deno.env.get("LOVABLE_API_KEY");
  const [sha, vision] = await Promise.all([
    sha256Hex(bytes),
    apiKey
      ? withTimeout(
          extractProofFieldsFromImage(base64FromBytes(bytes), blob.type || mimeFromPath(r.photo_path), apiKey),
          READER_TIMEOUT_MS,
          { fields: null, unverifiableReason: "reader_timeout" },
        )
      : Promise.resolve(null),
  ]);
  const read = toProofRead(vision, apiKey ? undefined : "reader_not_configured");

  const { data, error } = await admin.rpc("direct_pay_record_proof", {
    p_partner: user.id,
    p_payment_id: r.payment_id,
    p_photo_path: r.photo_path,
    p_photo_sha256: sha,
    p_provider: r.provider,
    p_tid_typed: r.tid_typed,
    p_amount_typed: r.amount_typed,
    p_read: read,
  });
  if (error) {
    console.error("[direct-pay-proof] record failed:", error.message);
    return json({ ok: false, code: "save_failed" }, 500);
  }
  return json(data);
});
