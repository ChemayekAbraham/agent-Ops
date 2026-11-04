import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { sendSMS, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";
import { isPlaceholderRecipient } from "../_shared/recipientMailbox.ts";
import { maskEmail } from "../_shared/twoFactorEmail.ts";

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
  // International number, with or without the +: 9-15 digits starting with a country code
  // (a bare 9-digit number is Ugandan, handled above)
  if (d.length >= 9 && d.length <= 15) return `+${d}`;
  return null;
}

const OLD_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CHALLENGES_PER_HOUR = 5;
// An inbox must have been on the account this long before it can approve a
// phone change. Without it, a stolen session could verify the attacker's own
// inbox (email-verify-request/confirm needs only a session) and then approve
// the SIM move from there.
const EMAIL_SETTLE_DAYS = 7;

type ApprovalEmail =
  | { ok: true; email: string }
  | { ok: false; reason: "no_email" | "email_too_new" | "check_failed"; usableFrom?: string };

/**
 * The inbox the approval code goes to. There is no other channel: without a
 * settled, confirmed inbox the user is told to add one first.
 *
 * Read from auth.users, never profiles.email: a signed-in user can write
 * profiles.email straight from the browser, so it proves nothing. The
 * EmailEditor flow (email-verify-request/confirm) proves the inbox and then
 * syncs it to auth.users with email_confirmed_at set.
 */
// deno-lint-ignore no-explicit-any
async function resolveApprovalEmail(admin: any, caller: any): Promise<ApprovalEmail> {
  const email = String(caller?.email ?? "").trim().toLowerCase();
  if (isPlaceholderRecipient(email) || !caller?.email_confirmed_at) {
    return { ok: false, reason: "no_email" };
  }

  const settleMs = EMAIL_SETTLE_DAYS * 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - settleMs).toISOString();
  let latestChange = 0;

  // Changed through Supabase's own email-change flow.
  const changeSentAt = caller?.email_change_sent_at ? Date.parse(caller.email_change_sent_at) : NaN;
  if (Number.isFinite(changeSentAt) && changeSentAt >= Date.now() - settleMs) latestChange = changeSentAt;

  // Changed through our email-verify flow. Re-proving the SAME address
  // (Agent Verification does this) is not a change and does not count.
  const { data: recent, error } = await admin
    .from("email_verification_challenges")
    .select("new_email, old_email, verified_at")
    .eq("user_id", caller.id)
    .not("verified_at", "is", null)
    .gte("verified_at", since)
    .limit(50);
  if (error) {
    console.error("email settle check failed", error);
    return { ok: false, reason: "check_failed" };
  }
  for (const r of (recent ?? []) as { new_email: string | null; old_email: string | null; verified_at: string }[]) {
    const isChange = String(r.new_email ?? "").trim().toLowerCase() !== String(r.old_email ?? "").trim().toLowerCase();
    const at = Date.parse(r.verified_at);
    if (isChange && Number.isFinite(at) && at > latestChange) latestChange = at;
  }

  if (latestChange > 0) {
    return { ok: false, reason: "email_too_new", usableFrom: new Date(latestChange + settleMs).toISOString() };
  }
  return { ok: true, email };
}

function formatEat(iso: string): string {
  return new Date(iso).toLocaleString("en-UG", {
    timeZone: "Africa/Kampala", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % 1_000_000).padStart(6, "0");
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

    // ── Second proof: the account's email inbox ──────────────────────────
    // Verifying only the NEW number lets anyone holding a live session (stolen
    // password, unlocked handset) move the account to a SIM they control. A
    // code emailed to the account's settled inbox must also be presented (it
    // used to go by SMS to the number being replaced; since 2026-11-04 it is
    // email only, and users without an inbox are told to add one). The
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
      // The approval code goes to the account's email inbox only. The new
      // number is already proven by its own SMS code (otp_verifications above).
      const approval = await resolveApprovalEmail(adminClient, caller);
      if (!approval.ok) {
        if (approval.reason === "no_email") {
          return json({
            error: "Add and confirm an email address first (Settings → Profile → Contact). We send the code to approve a phone change to your email.",
            code: "email_required",
          }, 400);
        }
        if (approval.reason === "email_too_new") {
          return json({
            error: `Your email was added or changed recently. For your safety it can approve a phone change from ${formatEat(approval.usableFrom!)} (EAT).`,
            code: "email_too_new",
            usable_from: approval.usableFrom,
          }, 400);
        }
        return json({ error: "Could not check your email. Please try again." }, 500);
      }
      const approvalEmail = approval.email;
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

      const { data: prof2 } = await adminClient
        .from("profiles").select("full_name").eq("id", caller.id).maybeSingle();
      const { data: mailRes, error: mailErr } = await adminClient.functions.invoke("send-transactional-email", {
        body: {
          templateName: "phone-change-code",
          recipientEmail: approvalEmail,
          idempotencyKey: `phone-change-code-${ch.id}`,
          templateData: {
            code,
            userName: String(prof2?.full_name ?? "").split(" ")[0] || "there",
            newPhoneLast3: last9.slice(-3),
            requestedAt: new Date().toISOString(),
            minutesValid: OLD_CODE_TTL_MS / 60000,
          },
        },
      });
      // send-transactional-email answers 200 with { success: false } when it
      // declines (suppressed recipient, provider refusal), so check both.
      const declined = mailRes && (mailRes as { success?: boolean }).success === false;
      if (mailErr || declined) {
        console.error("phone change code email failed", mailErr ?? mailRes);
        await adminClient.from("phone_change_otp_challenges").update({ status: "expired" }).eq("id", ch.id);
        return json({ error: "We could not email your approval code. Please try again in a few minutes." }, 502);
      }

      await adminClient.from("audit_logs").insert({
        user_id: caller.id, action_type: "user_phone_change_code_requested",
        table_name: "profiles", record_id: caller.id, reason: "settings_self_service",
        metadata: { to_last3: last9.slice(-3), channel: "email" },
      });
      const maskedDestination = maskEmail(approvalEmail);
      return json({
        success: true,
        channel: "email",
        masked_destination: maskedDestination,
        // Kept for older app builds, which read only this field.
        masked_phone: maskedDestination,
        expires_in_seconds: OLD_CODE_TTL_MS / 1000,
      });
    }

    if (hasOldPhone) {
      const oldCode = typeof body?.old_phone_code === "string" ? body.old_phone_code.trim() : "";
      if (!/^\d{6}$/.test(oldCode)) {
        return json({ error: "Enter the 6-digit approval code we emailed you.", code: "old_phone_code_required" }, 403);
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
        return json({ error: "That code has expired. Request a new one.", code: "old_phone_code_expired" }, 403);
      }
      if (ch.attempts >= ch.max_attempts) {
        await adminClient.from("phone_change_otp_challenges").update({ status: "failed" }).eq("id", ch.id);
        return json({ error: "Too many wrong attempts. Request a new code.", code: "old_phone_code_locked" }, 429);
      }
      if ((await sha256(oldCode)) !== ch.otp_hash) {
        await adminClient.from("phone_change_otp_challenges")
          .update({ attempts: ch.attempts + 1 }).eq("id", ch.id);
        return json({ error: "That code is incorrect.", code: "old_phone_code_invalid" }, 403);
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
        user_id: caller.id,
        action_type: "user_phone_revoked",
        table_name: "profiles",
        record_id: dup.id,
        reason: "reassigned_after_otp",
        metadata: { revoked_phone: normalized, reassigned_to: caller.id },
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
      user_id: caller.id,
      action_type: "user_phone_self_update",
      table_name: "auth.users",
      record_id: caller.id,
      reason: "settings_self_service",
      metadata: { phone: normalized, previous_last3: hasOldPhone ? oldLast9.slice(-3) : null, revoked_from: revokedFrom },
    });

    // Tell the previous number it happened, and that withdrawals pause for 24h
    // (enforced in issue-wallet-withdrawal-otp off the audit row above).
    if (hasOldPhone && isUgandanPhone(oldPhone)) {
      sendSMS(
        oldPhone,
        `Welile: login phone changed to ***${last9.slice(-3)}. Withdrawals paused 24h. Not you? Call support now.`,
        { admin: adminClient, source: "phone_change_notice", recipient_user_id: caller.id },
      ).catch((e) => console.error("phone change notice failed", e));
    }

    return json({ success: true, phone: normalized, revoked_from: revokedFrom });
  } catch (error: any) {
    console.error("self-update-phone error:", error);
    return json({ error: error?.message || "Failed to update phone" }, 400);
  }
});