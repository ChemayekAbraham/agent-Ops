// Server-side gate in front of the submit_identity_photos RPC: rejects a
// submission whose "National ID photo" isn't actually recognisable as a
// National ID card (blank photo, wrong document, unreadable), using the same
// AI-vision check as read-national-id. Previously that check only ran
// client-side as an optional autofill helper — a user could skip it entirely
// and upload any image as their ID photo, and the RPC stored it with no
// content check at all.
//
// Calls submit_identity_photos AS THE USER (forwarded JWT), not the service
// role, because that RPC reads auth.uid() internally to know whose identity
// is being verified — a service-role call would resolve auth.uid() to NULL
// and the RPC would refuse with "Please sign in again."
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const aiKey = Deno.env.get("LOVABLE_API_KEY");

    const authHeader = req.headers.get("Authorization") || req.headers.get("authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: { user }, error: authErr } = await admin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    // Scoped to the caller's own JWT so submit_identity_photos' auth.uid() resolves.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body = await req.json().catch(() => null) as {
      idPhotoPath?: string;
      selfiePath?: string;
      idBackPhotoPath?: string | null;
      nameChangeConsent?: boolean;
      selfieHash?: string | null;
      idHash?: string | null;
    } | null;

    const idPhotoPath = body?.idPhotoPath?.trim();
    const selfiePath = body?.selfiePath?.trim();
    if (!idPhotoPath || !selfiePath) {
      return json({ error: "Both the National ID photo and the selfie are required." }, 400);
    }
    if (idPhotoPath.split("/")[0] !== user.id || selfiePath.split("/")[0] !== user.id) {
      return json({ error: "Those photos do not belong to your account." }, 403);
    }

    // ---- AI-vision check: is this actually a National ID card? -------------
    // Fails OPEN (lets the submission through) when the AI gateway itself is
    // unavailable/erroring/unconfigured — we must never block a legitimate
    // user because a third-party service hiccuped. Fails CLOSED only when the
    // AI actually looked at the photo and confidently said it is not an ID.
    if (aiKey) {
      try {
        const { data: file, error: dlErr } = await admin.storage
          .from("identity-verification")
          .download(idPhotoPath);
        if (!dlErr && file) {
          const buf = new Uint8Array(await file.arrayBuffer());
          let bin = "";
          for (let i = 0; i < buf.length; i += 8192) {
            bin += String.fromCharCode(...buf.subarray(i, i + 8192));
          }
          const dataUrl = `data:${file.type || "image/jpeg"};base64,${btoa(bin)}`;

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
                    "You check whether a photo shows a Ugandan National ID card. Reply with JSON: " +
                    '{"is_national_id":boolean,"readable":boolean}. ' +
                    "is_national_id is false when the photo is blank, a different document, a screenshot " +
                    "of something else, or otherwise clearly not an identity card. readable is false when " +
                    "it IS an ID card but too blurry/dark/glared to read.",
                },
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Is this a National ID card?" },
                    { type: "image_url", image_url: { url: dataUrl } },
                  ],
                },
              ],
              response_format: { type: "json_object" },
            }),
          });

          if (aiRes.ok) {
            const payload = await aiRes.json();
            const text: string = payload?.choices?.[0]?.message?.content ?? "{}";
            let parsed: Record<string, unknown> = {};
            try { parsed = JSON.parse(text); } catch {
              const m = text.match(/\{[\s\S]*\}/);
              if (m) { try { parsed = JSON.parse(m[0]); } catch { /* keep empty, fail open */ } }
            }
            if (parsed.is_national_id === false) {
              return json({
                error: "That photo doesn't look like a National ID card. Please retake a clear photo of your National ID (all four corners visible, no glare).",
              }, 400);
            }
            if (parsed.readable === false) {
              return json({
                error: "We couldn't read your National ID clearly. Please retake the photo in better light.",
              }, 400);
            }
          } else {
            console.warn("[submit-identity-photos] AI gateway error, failing open:", aiRes.status);
          }
        } else {
          console.warn("[submit-identity-photos] could not download ID photo for AI check, failing open:", dlErr?.message);
        }
      } catch (e) {
        console.warn("[submit-identity-photos] AI check errored, failing open:", (e as Error)?.message || e);
      }
    }

    // ---- Hand off to the existing RPC, as the user --------------------------
    const { data, error } = await userClient.rpc("submit_identity_photos", {
      p_id_photo_path: idPhotoPath,
      p_selfie_path: selfiePath,
      p_id_back_photo_path: body?.idBackPhotoPath ?? null,
      p_name_change_consent: body?.nameChangeConsent ?? false,
    });
    if (error) return json({ error: error.message }, 400);

    // Best-effort. The Postgrest builder is thenable but has no .catch(), so
    // chaining one threw AFTER the submission had already been saved — the
    // whole call then returned 500 and the screen told the user nothing was
    // sent when in fact it had been.
    if (body?.selfieHash || body?.idHash) {
      try {
        await userClient.rpc("record_identity_image_hashes", {
          p_selfie_hash: body?.selfieHash ?? null,
          p_id_hash: body?.idHash ?? null,
        });
      } catch (e) {
        console.warn("[submit-identity-photos] hash recording failed:", (e as Error)?.message || e);
      }
    }

    return json(data);
  } catch (e) {
    console.error("[submit-identity-photos] unhandled", e);
    return json({ error: "Could not send your photos. Please try again." }, 500);
  }
});
