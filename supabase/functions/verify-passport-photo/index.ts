/**
 * Passport-photo quality check (PassGate).
 *
 * The tenant's browser posts the photo here; this function forwards it to the
 * PassGate analyze endpoint with our API key and returns a plain verdict.
 * The key never reaches the browser. PassGate is fire-and-forget: it stores no
 * uploaded photo, only grades it and returns a SHA-256 of the exact bytes.
 *
 * Read-only. No wallet, ledger or database writes happen here.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
const err = (msg: string, status = 400) => json({ error: msg }, status);

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png"];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Decode a `data:image/...;base64,...` URL (or bare base64) into bytes + mime. */
function decodeImage(input: string): { bytes: Uint8Array; mime: string } | null {
  const m = /^data:([a-zA-Z0-9/+.-]+);base64,(.*)$/s.exec(input.trim());
  const mime = (m?.[1] || "image/jpeg").toLowerCase();
  const b64 = (m ? m[2] : input).replace(/\s/g, "");
  if (!b64) return null;
  try {
    const raw = atob(b64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return { bytes, mime };
  } catch {
    return null;
  }
}

/** JPEG/PNG magic bytes — a renamed file must not slip through. */
function looksLikeJpegOrPng(b: Uint8Array): boolean {
  const jpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const png = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return jpeg || png;
}

interface PassGateCheck {
  id: string;
  label: string;
  status: string;
  severity: string;
  message?: string | null;
  hint?: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return err("Use POST", 405);

  const apiKey = Deno.env.get("PASSGATE_API_KEY");
  const base = (Deno.env.get("PASSGATE_API_BASE") || "https://verify.weliledev.com").replace(/\/+$/, "");
  if (!apiKey) return err("Photo checking is not configured", 503);

  // Signed-in tenants only: this proxies a paid third-party service.
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!token) return err("Sign in to continue", 401);
  const { data: authData, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !authData?.user) return err("Sign in to continue", 401);

  let body: { image_base64?: unknown };
  try {
    body = await req.json();
  } catch {
    return err("Invalid request body");
  }
  if (typeof body.image_base64 !== "string" || !body.image_base64) return err("No photo was sent");

  const decoded = decodeImage(body.image_base64);
  if (!decoded) return err("That photo could not be read");
  if (!ALLOWED_IMAGE_TYPES.includes(decoded.mime)) return err("Only JPG, JPEG or PNG photos are allowed");
  if (decoded.bytes.byteLength > MAX_IMAGE_BYTES) return err("That photo is larger than 5 MB");
  if (!looksLikeJpegOrPng(decoded.bytes)) return err("Only JPG, JPEG or PNG photos are allowed");

  const form = new FormData();
  form.append("image", new Blob([decoded.bytes], { type: decoded.mime }), "photo.jpg");
  form.append("view", "full");

  let res: Response;
  try {
    res = await fetch(`${base}/v1/analyze`, {
      method: "POST",
      headers: { "X-API-Key": apiKey },
      body: form,
    });
  } catch (e) {
    console.error("[verify-passport-photo] network failure", e);
    return json({ error: "Could not reach the photo checker", retryable: true }, 502);
  }

  const text = await res.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text);
  } catch { /* non-JSON body from an edge/proxy error */ }

  if (res.status === 401 || res.status === 403) {
    console.error("[verify-passport-photo] credential rejected", res.status, text.slice(0, 300));
    return json({ error: "Photo checking is not available right now" }, 502);
  }
  if (res.status === 429) {
    return json({ error: "Too many photo checks just now. Try again shortly.", retryable: true }, 429);
  }
  if (res.status === 503) {
    return json({ error: "The photo checker is starting up. Try again shortly.", retryable: true }, 503);
  }
  // 422 carries the analysis in the body — pass its reasons through, don't discard.
  if (!res.ok && res.status !== 422) {
    console.error("[verify-passport-photo] unexpected status", res.status, text.slice(0, 300));
    return json({ error: "That photo could not be checked" }, 502);
  }

  const checks = Array.isArray(payload.checks) ? (payload.checks as PassGateCheck[]) : [];
  const failures = checks
    .filter((c) => c && (c.status === "fail" || c.status === "warn") && c.severity !== "advisory")
    .map((c) => ({
      id: String(c.id ?? ""),
      label: String(c.label ?? c.id ?? ""),
      severity: String(c.severity ?? ""),
      advice: String(c.hint || c.message || "").trim(),
    }))
    .filter((c) => c.label);

  const isFace = payload.is_face === true;
  const verdict = String(payload.verdict ?? payload.status ?? (isFace ? "review" : "fail"));
  const image = (payload.image ?? {}) as { sha256?: unknown; width?: unknown; height?: unknown };

  return json({
    checked: true,
    is_face: isFace,
    is_passport_photo: payload.is_passport_photo === true,
    verdict, // "pass" | "review" | "fail"
    score: typeof payload.score === "number" ? payload.score : null,
    sha256: typeof image.sha256 === "string" ? image.sha256 : null,
    message: typeof payload.message === "string" ? payload.message : null,
    reason_code: typeof payload.error === "string" ? payload.error : null, // no_face | not_compliant | invalid_image
    failures,
  });
});
