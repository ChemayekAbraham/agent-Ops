// Step 2 of self-service email verification: check the code and adopt the
// address.
//
// The check and the write happen inside public.confirm_email_verification()
// so they are one transaction. This function's own job is to prove who is
// calling and to hash the code, so the plaintext never reaches the database.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function hashCode(code: string, userId: string, email: string): Promise<string> {
  const pepper = Deno.env.get("EMAIL_VERIFY_PEPPER") ?? "";
  const data = new TextEncoder().encode(`${code}:${userId}:${email}:${pepper}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const FRIENDLY: Record<string, string> = {
  challenge_not_found: "That request has expired. Start again.",
  already_used: "That code has already been used.",
  expired: "That code has expired. Request a new one.",
  too_many_attempts: "Too many wrong attempts. Request a new code.",
  wrong_code: "That code is not correct.",
  email_taken: "That address is already on another Welile account.",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "unauthorized" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const { data: userData, error: userErr } = await admin.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const challengeId = String(body?.challenge_id ?? "").trim();
    const code = String(body?.code ?? "").trim();

    if (!challengeId || !/^\d{6}$/.test(code)) {
      return json({ error: "invalid_input", message: "Enter the 6-digit code." }, 400);
    }

    // Read the challenge to learn which address the hash was bound to. Scoped
    // to the caller, so a leaked challenge id is not enough on its own.
    const { data: challenge, error: chErr } = await admin
      .from("email_verification_challenges")
      .select("id, user_id, new_email")
      .eq("id", challengeId)
      .eq("user_id", userId)
      .maybeSingle();
    if (chErr || !challenge) {
      return json({ error: "challenge_not_found", message: FRIENDLY.challenge_not_found }, 404);
    }

    const codeHash = await hashCode(code, userId, challenge.new_email);

    const { data: result, error: rpcErr } = await admin.rpc("confirm_email_verification", {
      p_challenge_id: challengeId,
      p_user_id: userId,
      p_code_hash: codeHash,
    });
    if (rpcErr) {
      console.error("confirm_email_verification failed", rpcErr);
      return json({ error: "unexpected", message: "Could not confirm the code." }, 500);
    }

    const res = (result ?? {}) as Record<string, unknown>;
    if (res.status === "error") {
      const reason = String(res.reason ?? "unexpected");
      return json({
        error: reason,
        message: FRIENDLY[reason] ?? "Could not confirm the code.",
        attempts_left: res.attempts_left ?? null,
      }, reason === "wrong_code" ? 400 : 409);
    }

    // The address is now the profile's. Bring the auth record along so the
    // user can still sign in with it, and so Supabase stops holding the old
    // placeholder. email_confirm skips Supabase's own confirmation link —
    // ownership was just proven by our code.
    let authSynced = true;
    const { error: authErr } = await admin.auth.admin.updateUserById(userId, {
      email: challenge.new_email,
      email_confirm: true,
    });
    if (authErr) {
      authSynced = false;
      console.error("auth email sync failed", { userId, error: authErr.message });
    }

    return json({
      status: "verified",
      email: res.email ?? challenge.new_email,
      auth_synced: authSynced,
    });
  } catch (e) {
    console.error("email-verify-confirm failed", e);
    return json({ error: "unexpected", message: String(e) }, 500);
  }
});
