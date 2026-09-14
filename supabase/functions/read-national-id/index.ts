// Reads the names / ID number printed on a National ID photo using Lovable AI.
// Called from the identity step of the withdraw flow BEFORE the photo is stored,
// so the person can confirm the details we detected.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const MAX_BASE64 = 14 * 1024 * 1024; // ~10MB image once base64-encoded

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const aiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!aiKey) return json({ error: "AI is not configured" }, 500);

    const adminClient = createClient(supabaseUrl, serviceKey);
    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authError } = await adminClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => null) as
      | { imageBase64?: string; storagePath?: string; side?: string; targetUserId?: string }
      | null;

    const side = body?.side === "back" ? "back" : "front";

    /** Records every read attempt so Financial Ops can audit what was seen. */
    const logRead = async (row: Record<string, unknown>) => {
      try {
        await adminClient.from("national_id_ocr_reads").insert({
          user_id: user.id,
          side,
          storage_path: body?.storagePath ?? null,
          ...row,
        });
      } catch (e) {
        console.error("read-national-id audit log failed", e);
      }
    };

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

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Lovable-API-Key": aiKey,
        "X-Lovable-AIG-SDK": "fetch",
      },
      body: JSON.stringify({
        model: "google/gemini-3.8-flash",
        messages: [
          {
            role: "system",
            content:
              "You read Ugandan National ID cards. Return ONLY the printed details, never guesses. " +
              'Reply with JSON: {"full_name":string,"surname":string,"given_names":string,' +
              '"id_number":string,"date_of_birth":string,"is_national_id":boolean,"readable":boolean}. ' +
              "Use an empty string for anything not clearly legible. " +
              "is_national_id is false when the photo is not an identity card.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Read the names and ID number on this card." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!aiRes.ok) {
      const detail = await aiRes.text();
      const status = aiRes.status;
      const message = status === 429
        ? "Too many photo checks right now. Please try again in a moment."
        : status === 402 || status === 403
        ? "Automatic ID reading is unavailable. You can still type your details."
        : "Could not read that photo automatically. You can still type your details.";
      console.error("read-national-id gateway error", status, detail.slice(0, 400));
      return json({ error: message, status }, status === 429 ? 429 : 200);
    }

    const payload = await aiRes.json();
    const text: string = payload?.choices?.[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* keep empty */ } }
    }

    const fullName = String(parsed.full_name ?? "").trim();
    const idNumber = String(parsed.id_number ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

    // Compare against the account holder's name so a mismatch is caught early.
    const { data: profile } = await adminClient
      .from("profiles")
      .select("full_name, national_id")
      .eq("id", user.id)
      .maybeSingle();

    const accountName = String(profile?.full_name ?? "");
    const score = fullName && accountName ? nameMatchScore(fullName, accountName) : null;

    return json({
      full_name: fullName,
      surname: String(parsed.surname ?? "").trim(),
      given_names: String(parsed.given_names ?? "").trim(),
      id_number: idNumber,
      date_of_birth: String(parsed.date_of_birth ?? "").trim(),
      is_national_id: parsed.is_national_id !== false,
      readable: parsed.readable !== false && !!fullName,
      account_name: accountName,
      account_national_id: profile?.national_id ?? null,
      name_match_score: score,
    });
  } catch (e) {
    console.error("read-national-id failed", e);
    return json({ error: "Could not read that photo. You can still type your details." }, 200);
  }
});
