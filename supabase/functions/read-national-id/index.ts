// Reads a Ugandan National ID card through PassGate `POST /v1/id/read`.
//
// WHY PASSGATE AND NOT A LANGUAGE MODEL
// This used to ask Gemini to read the card and return JSON. A language model
// will always return *something*, so a misread came back looking exactly like a
// good read. PassGate validates every field against its format and reports an
// unreadable field as missing rather than guessing: "a plausible-looking wrong
// NIN is far worse than an honest failure" (OCR_NATIONAL_ID.md §2).
//
// It also tells us three things the model could not: whether the photo is a
// Ugandan National ID at all (`status: invalid`), which specific fields failed
// (`missing`), and whether the NIN's own internal characters agree with the
// separately-read sex and birth year (`consistency`).
//
// PRIVACY — this response carries a person's full name, NIN, date of birth and
// card number in one object. Per OCR_NATIONAL_ID.md §10 it is NEVER logged.
// Errors log a status code and nothing else.
//
// Read-only. No wallet, ledger or database writes happen here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_BASE64 = 16 * 1024 * 1024; // PassGate accepts 12 MB decoded
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/bmp"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Uppercase, letters-only comparison key for a printed name. */
function nameTokens(v: string): string[] {
  return (v || "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

function nameMatchScore(a: string, b: string): number {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return 0;
  const hits = x.filter((t) => y.includes(t)).length;
  return hits / Math.max(x.length, y.length);
}

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

interface IdField {
  value?: unknown;
  raw?: unknown;
  confidence?: unknown;
  valid?: unknown;
  note?: unknown;
}

const REQUIRED_FIELDS = ["surname", "given_name", "nin", "date_of_birth", "card_number", "sex"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("PASSGATE_API_KEY");
    const base = (Deno.env.get("PASSGATE_API_BASE") || "https://verify.weliledev.com").replace(/\/+$/, "");
    if (!apiKey) return json({ error: "ID reading is not configured. You can still type your details." }, 200);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authError } = await adminClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => null) as
      | { imageBase64?: string; storagePath?: string }
      | null;

    let dataUrl: string | null = null;

    if (body?.imageBase64) {
      const raw = body.imageBase64;
      if (raw.length > MAX_BASE64) return json({ error: "That photo is too large." }, 400);
      dataUrl = raw.startsWith("data:") ? raw : `data:image/jpeg;base64,${raw}`;
    } else if (body?.storagePath) {
      // Only the owner's own stored photo may be read this way.
      if (body.storagePath.split("/")[0] !== user.id) {
        return json({ error: "That photo does not belong to you." }, 403);
      }
      const { data: file, error: dlErr } = await adminClient.storage
        .from("identity-verification")
        .download(body.storagePath);
      if (dlErr || !file) return json({ error: "Could not open that photo." }, 400);
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 8192) {
        bin += String.fromCharCode(...buf.subarray(i, i + 8192));
      }
      dataUrl = `data:${file.type || "image/jpeg"};base64,${btoa(bin)}`;
    }

    if (!dataUrl) return json({ error: "No photo was sent." }, 400);

    const decoded = decodeImage(dataUrl);
    if (!decoded) return json({ error: "That photo could not be read." }, 400);
    if (!ALLOWED_IMAGE_TYPES.includes(decoded.mime)) {
      return json({ error: "Only JPG, PNG, WebP or BMP photos can be read." }, 400);
    }
    if (decoded.bytes.byteLength > MAX_IMAGE_BYTES) {
      return json({ error: "That photo is larger than 12 MB." }, 400);
    }

    /* `view=full` carries the per-field `valid` flags and notes. Those are what
       the screen needs to tell the person WHICH field to fix, instead of a bare
       "could not read". `debug` is never requested — it returns a 212 KB
       annotated copy of somebody's ID card. */
    const form = new FormData();
    form.append("image", new Blob([decoded.bytes], { type: decoded.mime }), "national-id.jpg");
    form.append("view", "full");

    let res: Response;
    try {
      res = await fetch(`${base}/v1/id/read`, {
        method: "POST",
        headers: { "X-API-Key": apiKey },
        body: form,
      });
    } catch {
      // No detail logged: the failure carries the image.
      console.error("[read-national-id] network failure reaching the ID reader");
      return json({ error: "Could not reach the ID reader. You can still type your details.", retryable: true }, 200);
    }

    if (res.status === 401 || res.status === 403) {
      console.error("[read-national-id] credential rejected", res.status);
      return json({ error: "ID reading is unavailable right now. You can still type your details." }, 200);
    }
    if (res.status === 429) {
      return json({ error: "Too many ID checks just now. Try again shortly.", retryable: true }, 200);
    }
    if (!res.ok && res.status !== 422) {
      console.error("[read-national-id] unexpected status", res.status);
      return json({ error: "That photo could not be read. You can still type your details." }, 200);
    }

    let payload: Record<string, unknown> = {};
    try {
      payload = await res.json();
    } catch {
      console.error("[read-national-id] non-JSON response", res.status);
      return json({ error: "That photo could not be read. You can still type your details." }, 200);
    }

    const rawData = (payload.data ?? {}) as Record<string, unknown>;
    const rawFields = (payload.fields ?? {}) as Record<string, IdField>;

    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const data = {
      surname: str(rawData.surname),
      given_name: str(rawData.given_name),
      nin: str(rawData.nin).toUpperCase(),
      date_of_birth: str(rawData.date_of_birth), // already ISO — never re-parse
      card_number: str(rawData.card_number),
      sex: str(rawData.sex).toUpperCase(),
    };

    // Only the flags the screen branches on. `raw` is deliberately dropped.
    const fields: Record<string, { valid: boolean; confidence: number | null; note: string | null }> = {};
    for (const key of REQUIRED_FIELDS) {
      const f = rawFields[key];
      if (!f) continue;
      fields[key] = {
        valid: f.valid === true,
        confidence: typeof f.confidence === "number" ? f.confidence : null,
        note: typeof f.note === "string" ? f.note : null,
      };
    }

    const status = str(payload.status) || (payload.is_national_id === true ? "incomplete" : "invalid");
    const missing = Array.isArray(payload.missing) ? (payload.missing as unknown[]).map(str).filter(Boolean) : [];

    const consistency = Array.isArray(payload.consistency)
      ? (payload.consistency as Record<string, unknown>[])
          .filter((c) => c && c.passed === false)
          .map((c) => ({ id: str(c.id), detail: str(c.detail) }))
      : [];

    const fullName = str(payload.full_name) ||
      [data.given_name, data.surname].filter(Boolean).join(" ");

    // Compare against the account holder's name so a mismatch is caught early.
    const { data: profile } = await adminClient
      .from("profiles")
      .select("full_name, national_id")
      .eq("id", user.id)
      .maybeSingle();

    const accountName = String(profile?.full_name ?? "");
    const score = fullName && accountName ? nameMatchScore(fullName, accountName) : null;

    return json({
      status,                                   // valid | incomplete | invalid
      is_national_id: payload.is_national_id === true,
      confidence: typeof payload.confidence === "number" ? payload.confidence : null,
      sha256: str(payload.sha256) || null,
      full_name: fullName,
      data,
      fields,
      missing,
      consistency,                              // FAILED cross-checks only
      message: str(payload.message) || null,
      account_name: accountName,
      account_national_id: profile?.national_id ?? null,
      name_match_score: score,
    });
  } catch {
    // Never log the exception body — it can carry the decoded card.
    console.error("[read-national-id] unhandled failure");
    return json({ error: "Could not read that photo. You can still type your details." }, 200);
  }
});
