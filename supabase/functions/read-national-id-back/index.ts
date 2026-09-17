// Reads the BACK of a Ugandan National ID card.
//
// WHY A SEPARATE READER
// PassGate's `/v1/id/read` is a FRONT-side reader: it validates surname, given
// name, NIN, date of birth, card number and sex, and a back-side photo comes
// back as "not a National ID". So the back — which is where the card number,
// the dates of issue and expiry, the place of residence and the two machine
// lines are printed — was never actually extracted.
//
// The back carries no field with a checkable national format the way the NIN
// has, so the honest source of truth here is the MRZ (the two/three machine
// lines at the bottom). Whatever the vision model claims is CROSS-CHECKED
// against the MRZ, and any field the MRZ contradicts is reported as unverified
// rather than presented as read. Nothing here is ever auto-trusted into the
// person's record: the front reader still owns the identity fields.
//
// PRIVACY — this response carries the NIN, card number, dates and residence of
// a real person. It is NEVER logged. Errors log a status code and nothing else.
//
// Read-only. No wallet, ledger or database writes happen here.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_BASE64 = 16 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/bmp"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const upper = (v: unknown) => str(v).toUpperCase();

/** `data:image/...;base64,...` (or bare base64) → bytes + mime. */
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

/* ---------------- MRZ (ICAO 9303 TD1, three lines of 30) ---------------- */

/** YYMMDD → ISO, windowed: a birth year reads back, an expiry reads forward. */
function mrzDate(v: string, kind: "past" | "future"): string {
  if (!/^\d{6}$/.test(v)) return "";
  const yy = Number(v.slice(0, 2));
  const mm = v.slice(2, 4);
  const dd = v.slice(4, 6);
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return "";
  const nowYY = new Date().getUTCFullYear() % 100;
  const century = kind === "past"
    ? (yy > nowYY ? 1900 : 2000)
    : (yy < nowYY - 20 ? 2100 : 2000);
  return `${century + yy}-${mm}-${dd}`;
}

/** ICAO check digit over 7-3-1 weights. */
function checkDigit(s: string): number {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const v = c === "<" ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55;
    sum += v * weights[i % 3];
  }
  return sum % 10;
}

interface MrzResult {
  lines: string[];
  document_number: string | null;
  nin: string | null;
  date_of_birth: string | null;
  date_of_expiry: string | null;
  sex: string | null;
  nationality: string | null;
  surname: string | null;
  given_name: string | null;
  /** Every check digit in the zone agreed with its own field. */
  checksums_ok: boolean | null;
}

const FINANCE_ROLES = ["financial_ops", "cfo", "manager", "super_admin", "ceo", "coo"];

/** True when the caller is allowed to read another user's identity photo. */
async function isFinanceReviewer(
  admin: ReturnType<typeof createClient>,
  callerId: string,
): Promise<boolean> {
  try {
    const checks = await Promise.all(
      FINANCE_ROLES.map((role) =>
        admin.rpc("has_role", { _user_id: callerId, _role: role }).then(({ data }) => data === true)
      ),
    );
    return checks.some(Boolean);
  } catch {
    return false;
  }
}

/**
 * Parses the machine-readable zone out of whatever text the model transcribed.
 * The MRZ is self-verifying, which is why it — not the model's prose — is the
 * authority for the fields it carries.
 */
function parseMrz(raw: string): MrzResult | null {
  const candidates = raw
    .toUpperCase()
    .split(/[\r\n]+/)
    .map((l) => l.replace(/\s+/g, ""))
    .filter((l) => l.length >= 24 && /^[A-Z0-9<]+$/.test(l) && l.includes("<"));
  if (candidates.length < 2) return null;

  // TD1 lines are 30 characters. Pad or trim so fixed offsets hold.
  const norm = (l: string) => (l.length >= 30 ? l.slice(0, 30) : l.padEnd(30, "<"));
  const l1 = norm(candidates[0]);
  const l2 = norm(candidates[1]);
  const l3 = candidates[2] ? norm(candidates[2]) : "";

  const documentNumber = l1.slice(5, 14).replace(/</g, "");
  const docCheck = l1.slice(14, 15);
  // Uganda prints the NIN in the optional data of line 1.
  const optional1 = l1.slice(15, 30).replace(/</g, "");

  const dob = l2.slice(0, 6);
  const dobCheck = l2.slice(6, 7);
  const sex = l2.slice(7, 8);
  const exp = l2.slice(8, 14);
  const expCheck = l2.slice(14, 15);
  const nationality = l2.slice(15, 18).replace(/</g, "");

  const names = l3 ? l3.split("<<") : [];
  const surname = (names[0] || "").replace(/</g, " ").trim();
  const given = (names[1] || "").replace(/</g, " ").trim();

  const checks = [
    /^\d$/.test(docCheck) ? checkDigit(l1.slice(5, 14)) === Number(docCheck) : null,
    /^\d$/.test(dobCheck) ? checkDigit(dob) === Number(dobCheck) : null,
    /^\d$/.test(expCheck) ? checkDigit(exp) === Number(expCheck) : null,
  ].filter((c): c is boolean => c !== null);

  return {
    lines: [l1, l2, l3].filter(Boolean),
    document_number: documentNumber || null,
    nin: optional1 || null,
    date_of_birth: mrzDate(dob, "past") || null,
    date_of_expiry: mrzDate(exp, "future") || null,
    sex: /^[MF]$/.test(sex) ? sex : null,
    nationality: nationality || null,
    surname: surname || null,
    given_name: given || null,
    checksums_ok: checks.length ? checks.every(Boolean) : null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lovableKey = Deno.env.get("LOVABLE_API_KEY");

    const adminClient = createClient(supabaseUrl, serviceKey);
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authError } = await adminClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    if (!lovableKey) {
      // The back is archived either way — never block the person on this.
      return json({ error: "Back-of-card reading is not configured. Your photo is still saved." }, 200);
    }

    const body = await req.json().catch(() => null) as
      | { imageBase64?: string; storagePath?: string }
      | null;

    let dataUrl: string | null = null;
    if (body?.imageBase64) {
      const raw = body.imageBase64;
      if (raw.length > MAX_BASE64) return json({ error: "That photo is too large." }, 400);
      dataUrl = raw.startsWith("data:") ? raw : `data:image/jpeg;base64,${raw}`;
    } else if (body?.storagePath) {
      const ownerId = body.storagePath.split("/")[0];
      const canReadCrossUser = ownerId !== user.id && await isFinanceReviewer(adminClient, user.id);
      if (ownerId !== user.id && !canReadCrossUser) {
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

    const prompt =
      "You are reading the BACK of a Ugandan National ID card (NIRA). Transcribe only what is " +
      "printed; never invent, complete or correct a value. Return JSON with exactly these keys:\n" +
      '"side": "back" if you can see the two or three machine-readable lines of blocky ' +
      "A-Z/0-9/< characters along the bottom edge, or \"front\" if you instead see the holder's " +
      "portrait photograph with SURNAME/GIVEN NAME and a NIN on the same face.\n" +
      '"is_national_id": true only if this is a Ugandan National ID card at all.\n' +
      '"mrz_text": the machine-readable lines EXACTLY as printed, one line per newline, ' +
      "keeping every < character. Empty string if you cannot see them.\n" +
      '"card_number": the card/document number printed on the back, else "".\n' +
      '"date_of_issue" and "date_of_expiry": as ISO YYYY-MM-DD, else "".\n' +
      '"district", "county", "subcounty", "parish", "village": the place of residence lines, ' +
      "else \"\".\n" +
      '"other_fields": an array of {"label","value"} for any other printed line you can read.\n' +
      '"readable": false if the print is too blurred, dark or glared to transcribe.';

    let aiRes: Response;
    try {
      aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${lovableKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-3.8-flash",
          messages: [
            { role: "system", content: prompt },
            {
              role: "user",
              content: [
                { type: "text", text: "Read the back of this National ID card." },
                { type: "image_url", image_url: { url: dataUrl } },
              ],
            },
          ],
          response_format: { type: "json_object" },
        }),
      });
    } catch {
      console.error("[read-national-id-back] network failure reaching the reader");
      return json({ error: "Could not reach the card reader. Your photo is still saved.", retryable: true }, 200);
    }

    if (aiRes.status === 429) {
      return json({ error: "Too many card checks just now. Try again shortly.", retryable: true }, 200);
    }
    if (aiRes.status === 402 || aiRes.status === 403) {
      console.error("[read-national-id-back] reading blocked", aiRes.status);
      return json({ error: "Back-of-card reading is unavailable right now. Your photo is still saved." }, 200);
    }
    if (!aiRes.ok) {
      console.error("[read-national-id-back] unexpected status", aiRes.status);
      return json({ error: "That photo could not be read. Your photo is still saved." }, 200);
    }

    let parsed: Record<string, unknown> = {};
    try {
      const payload = await aiRes.json();
      const text: string = payload?.choices?.[0]?.message?.content ?? "{}";
      try {
        parsed = JSON.parse(text);
      } catch {
        const m = text.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
      }
    } catch {
      console.error("[read-national-id-back] unparseable response");
      return json({ error: "That photo could not be read. Your photo is still saved." }, 200);
    }

    const mrz = parseMrz(str(parsed.mrz_text));

    /* The MRZ wins wherever it speaks: it carries its own check digits, the
       model's prose carries none. A model value the MRZ contradicts is dropped
       rather than shown, so nobody confirms a number that is not on the card. */
    const claimedCard = upper(parsed.card_number).replace(/[^A-Z0-9]/g, "");
    const mrzCard = (mrz?.document_number ?? "").toUpperCase();
    const cardNumber = mrzCard || claimedCard;
    const cardNumberAgrees = mrzCard && claimedCard ? mrzCard === claimedCard : null;

    const claimedExpiry = str(parsed.date_of_expiry);
    const expiry = mrz?.date_of_expiry || claimedExpiry || null;
    const expiryAgrees = mrz?.date_of_expiry && claimedExpiry
      ? mrz.date_of_expiry === claimedExpiry
      : null;

    const residence = {
      district: upper(parsed.district) || null,
      county: upper(parsed.county) || null,
      subcounty: upper(parsed.subcounty) || null,
      parish: upper(parsed.parish) || null,
      village: upper(parsed.village) || null,
    };

    const other = Array.isArray(parsed.other_fields)
      ? (parsed.other_fields as Record<string, unknown>[])
          .map((f) => ({ label: str(f?.label), value: str(f?.value) }))
          .filter((f) => f.label && f.value)
          .slice(0, 12)
      : [];

    const side = str(parsed.side).toLowerCase() === "front" ? "front" : "back";
    // The machine lines only exist on the back, so seeing them settles the side
    // regardless of what the model called it.
    const resolvedSide = mrz ? "back" : side;

    return json({
      is_national_id: parsed.is_national_id !== false,
      side: resolvedSide,
      readable: parsed.readable !== false && (!!mrz || !!cardNumber || other.length > 0),
      card_number: cardNumber || null,
      card_number_agrees: cardNumberAgrees,
      date_of_issue: str(parsed.date_of_issue) || null,
      date_of_expiry: expiry,
      date_of_expiry_agrees: expiryAgrees,
      residence,
      other_fields: other,
      mrz: mrz
        ? {
            present: true,
            lines: mrz.lines,
            checksums_ok: mrz.checksums_ok,
            nin: mrz.nin,
            document_number: mrz.document_number,
            date_of_birth: mrz.date_of_birth,
            date_of_expiry: mrz.date_of_expiry,
            sex: mrz.sex,
            nationality: mrz.nationality,
            surname: mrz.surname,
            given_name: mrz.given_name,
          }
        : { present: false },
    });
  } catch {
    console.error("[read-national-id-back] unhandled failure");
    return json({ error: "Could not read that photo. Your photo is still saved." }, 200);
  }
});
