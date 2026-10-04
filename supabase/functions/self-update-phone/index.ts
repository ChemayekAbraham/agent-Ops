import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/**
 * Strict canonical normalization — mirrors public.normalize_e164_phone in the DB.
 * Returns a valid E.164 string, or null when the input cannot be coerced to a
 * valid number (e.g. malformed 11-digit local entries like "07827277378").
 */
function normalizePhone(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  const hadPlus = s.startsWith("+");
  const d = s.replace(/\D/g, "");
  if (!d) return null;

  // Ugandan local form: leading 0, no country code (e.g. 0771234567)
  if (!hadPlus && d.startsWith("0")) {
    const national = d.slice(1).replace(/^0+/, "");
    return national.length === 9 ? `+256${national}` : null;
  }
  // Uganda country code, with or without + (e.g. 256771234567)
  if (d.startsWith("256")) {
    const national = d.slice(3).replace(/^0+/, "");
    return national.length === 9 ? `+256${national}` : null;
  }
  // Bare 9-digit Ugandan number without any prefix (e.g. 771234567)
  if (!hadPlus && d.length === 9) return `+256${d}`;
  // Explicit international number: + followed by 9-15 digits
  if (hadPlus && d.length >= 9 && d.length <= 15) return `+${d}`;
  return null;
}

const OLD_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CHALLENGES_PER_HOUR = 5;

function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  return digits.length < 6 ? "•••••" : `+••• ••• ${digits.slice(-3)}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: authData, error: authErr } = await adminClient.auth.getUser(token);
    const caller = authData?.user;
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const rawPhone = typeof body?.phone === "string" ? body.phone : "";
    if (!rawPhone.trim()) return json({ error: "Phone number is required" }, 400);

    const normalized = normalizePhone(rawPhone);
    // Reject anything that can't be coerced to a valid canonical number.
    if (!normalized || !/^\+\d{9,15}$/.test(normalized)) {
      return json({ error: "Please enter a valid phone number" }, 400);
    }
    const authPhone = normalized.replace(/^\+/, "");

    // Require recent OTP verification for the new phone (last 10 minutes).
    // The sms-otp function stores rows keyed by the last 9 digits of the phone.
    const last9 = authPhone.slice(-9);
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: otpRow } = await adminClient
      .from("otp_verifications")
      .select("verified, verified_at")
      .eq("phone", last9)
      .eq("verified", true)
      .gte("verified_at", tenMinAgo)
      .order("verified_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!otpRow) {
      return json({ error: "Please verify this phone number with an SMS code before saving." }, 403);
    }

    // ── Proof of the CURRENT login phone ─────────────────────────────────
    // Verifying only the NEW number lets anyone holding a live session (stolen
    // password, unlocked handset) move the account to a SIM they control. A
    // code sent to the number being replaced must also be presented. The
    // challenge is bound to this user and to this exact target number, is
    // single-use, and is stored hashed.
    const { data: prof } = await adminClient
      .from("profiles").select("phone").eq("id", caller.id).maybeSingle();
    const oldPhone = String(prof?.phone ?? caller.phone ?? "").trim();
    const oldLast9 = oldPhone.replace(/\D/g, "").slice(-9);
    const hasOldPhone = oldLast9.length === 9;
    if (hasOldPhone && oldLast9 === last9) {
      return json({ error: "That is already your login phone." }, 400);
    }

    if (body?.action === "request_old_phone_code") {
      if (!hasOldPhone) return json({ success: true, not_required: true });
      if (!isUgandanPhone(oldPhone)) {
        return json({ error: "We cannot text your current number. Please contact support to change your login phone." }, 400);
      }
      const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count } = await adminClient
        .from("phone_change_otp_challenges")
        .select("id", { count: "exact", head: true })
        .eq("user_id", caller.id)
        .gte("created_at", hourAgo);
      if ((count ?? 0) >= MAX_CHALLENGES_PER_HOUR) {
        return json({ error: "Too many code requests. Try again in an hour." }, 429);
      }
      // Any earlier unused code is dead the moment a new one is issued.
      await adminClient.from("phone_change_otp_challenges")
        .update({ status: "expired" })
        .eq("user_id", caller.id).eq("status", "pending");
      const code = generateOtp();
      const { data: ch, error: chErr } = await adminClient
        .from("phone_change_otp_challenges")
        .insert({
          user_id: caller.id,
          old_phone: oldPhone,
          new_phone_last9: last9,
          otp_hash: await sha256(code),
          otp_expires_at: new Date(Date.now() + OLD_CODE_TTL_MS).toISOString(),
        })
        .select("id").single();
      if (chErr || !ch) return json({ error: "Could not create verification code" }, 500);
      await sendSMS(
        oldPhone,
        `Welile: code ${code} approves changing your login phone to ***${last9.slice(-3)}. Valid 10 min. Not you? Do not share it and call support.`,
        { admin: adminClient, source: "phone_change_old_number_otp", reference_id: ch.id, recipient_user_id: caller.id },
      );
      await adminClient.from("audit_logs").insert({
        actor_id: caller.id, action_type: "user_phone_change_code_requested",
        table_name: "profiles", record_id: caller.id, reason: "settings_self_service",
        details: { to_last3: last9.slice(-3) },
      });
      return json({ success: true, masked_phone: maskPhone(oldPhone), expires_in_seconds: OLD_CODE_TTL_MS / 1000 });
    }

    if (hasOldPhone) {
      const oldCode = typeof body?.old_phone_code === "string" ? body.old_phone_code.trim() : "";
      if (!/^\d{6}$/.test(oldCode)) {
        return json({ error: "old_phone_code_required", message: `Enter the 6-digit code we sent to your current number ${maskPhone(oldPhone)}.` }, 403);
      }
      const { data: ch } = await adminClient
        .from("phone_change_otp_challenges")
        .select("*")
        .eq("user_id", caller.id)
        .eq("status", "pending")
        .eq("new_phone_last9", last9)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!ch || new Date(ch.otp_expires_at) < new Date()) {
        return json({ error: "old_phone_code_expired", message: "That code has expired. Request a new one." }, 403);
      }
      if (ch.attempts >= ch.max_attempts) {
        await adminClient.from("phone_change_otp_challenges").update({ status: "failed" }).eq("id", ch.id);
        return json({ error: "old_phone_code_locked", message: "Too many wrong attempts. Request a new code." }, 429);
      }
      if ((await sha256(oldCode)) !== ch.otp_hash) {
        await adminClient.from("phone_change_otp_challenges")
          .update({ attempts: ch.attempts + 1 }).eq("id", ch.id);
        return json({ error: "old_phone_code_invalid", message: "That code is incorrect." }, 403);
      }
      // Single use: burn it before any state changes so a replay cannot succeed.
      await adminClient.from("phone_change_otp_challenges")
        .update({ status: "consumed", consumed_at: new Date().toISOString() }).eq("id", ch.id);
    }

    // Duplicate handling — the caller has proven ownership of this SIM via a
    // recent OTP, so any OTHER account still holding this number is revoked
    // (its phone is cleared) before we assign the number to the caller.
    // IMPORTANT: a stale holder can exist at the login (auth) level even when
    // its visible profile phone is a completely different number. Checking only
    // profiles.phone missed those and the auth update failed with
    // "phone number already registered". We now union both sources.
    const { data: dupProfiles } = await adminClient
      .from("profiles")
      .select("id")
      .or(`phone.eq.${normalized},phone.eq.${authPhone}`)
      .neq("id", caller.id);

    const { data: dupAuthRows, error: dupAuthErr } = await adminClient.rpc(
      "auth_user_ids_by_phone_last9",
      { p_last9: last9 },
    );
    if (dupAuthErr) {
      console.error("auth phone duplicate lookup failed:", dupAuthErr);
    }

    const dupIds = new Set<string>();
    for (const p of dupProfiles ?? []) dupIds.add(p.id as string);
    for (const a of (dupAuthRows ?? []) as { user_id: string }[]) {
      if (a.user_id && a.user_id !== caller.id) dupIds.add(a.user_id);
    }
    dupIds.delete(caller.id);

    const revokedFrom: string[] = [];
    for (const dup of [...dupIds].map((id) => ({ id }))) {
      // Clear the phone on the previous owner's auth account so the unique
      // auth.users phone constraint doesn't block the caller's update.
      const { error: revokeAuthErr } = await adminClient.auth.admin.updateUserById(dup.id, {
        phone: "",
      });
      if (revokeAuthErr) {
        console.error("failed to revoke auth phone for", dup.id, revokeAuthErr);
      }
      // Clear the mirrored profile phone ONLY when it is the same number.
      // A stale auth-level holder can have a legitimately different profile
      // phone, which must be left intact. Mobile money / withdrawal details
      // are never touched here.
      const { data: dupProfile } = await adminClient
        .from("profiles")
        .select("phone")
        .eq("id", dup.id)
        .maybeSingle();
      const dupLast9 = (dupProfile?.phone ?? "").replace(/\D/g, "").slice(-9);
      if (dupLast9 && dupLast9 === last9) {
        await adminClient.from("profiles").update({ phone: null }).eq("id", dup.id);
      }
      // Audit the revocation against the previous owner.
      await adminClient.from("audit_logs").insert({
        actor_id: caller.id,
        action_type: "user_phone_revoked",
        table_name: "profiles",
        record_id: dup.id,
        reason: "reassigned_after_otp",
        details: { revoked_phone: normalized, reassigned_to: caller.id },
      });
      revokedFrom.push(dup.id);
    }

    // Update auth.users
    const { error: updErr } = await adminClient.auth.admin.updateUserById(caller.id, {
      phone: authPhone,
      phone_confirm: true,
    });
    if (updErr) throw updErr;

    // Mirror to profiles
    const { error: profErr } = await adminClient
      .from("profiles")
      .update({ phone: normalized })
      .eq("id", caller.id);
    if (profErr) throw profErr;

    // Audit
    await adminClient.from("audit_logs").insert({
      actor_id: caller.id,
      action_type: "user_phone_self_update",
      table_name: "auth.users",
      record_id: caller.id,
      reason: "settings_self_service",
      details: { phone: normalized, previous_last3: hasOldPhone ? oldLast9.slice(-3) : null, revoked_from: revokedFrom },
    });

    // Tell the previous number it happened, and that withdrawals pause for 24h
    // (enforced in issue-wallet-withdrawal-otp off the audit row above).
    if (hasOldPhone && isUgandanPhone(oldPhone)) {
      sendSMS(
        oldPhone,
        `Welile: your login phone was changed to ***${last9.slice(-3)}. Withdrawals are paused for 24 hours. Not you? Call support now.`,
        { admin: adminClient, source: "phone_change_notice", recipient_user_id: caller.id },
      ).catch((e) => console.error("phone change notice failed", e));
    }

    return json({ success: true, phone: normalized, revoked_from: revokedFrom });
  } catch (error: any) {
    console.error("self-update-phone error:", error);
    return json({ error: error?.message || "Failed to update phone" }, 400);
  }
});