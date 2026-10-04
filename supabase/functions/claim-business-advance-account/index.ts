import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function cleanPhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s/g, "");
  if (!/^0[3-9][0-9]{8}$/.test(v)) return null;
  return v;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const phone = cleanPhone(body?.phone);
    const password = typeof body?.password === "string" ? body.password : "";
    const fullName = typeof body?.full_name === "string" ? body.full_name.trim() : "";

    if (!phone) {
      return new Response(JSON.stringify({ error: "Invalid Ugandan phone number" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (password.length < 8) {
      return new Response(JSON.stringify({ error: "Password must be at least 8 characters" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Find profile by phone
    const { data: profile } = await admin
      .from("profiles")
      .select("id, full_name, email")
      .eq("phone", phone)
      .maybeSingle();

    // 2. Require an existing business advance for this phone (proves the agent
    //    legitimately requested onboarding for them — no random self-claims).
    if (profile?.id) {
      const { count } = await admin
        .from("business_advances")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", profile.id);
      if (!count || count === 0) {
        return new Response(JSON.stringify({ error: "No Business Advance request found for this number" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      return new Response(JSON.stringify({ error: "No Business Advance request found for this number" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const digits = phone.replace(/\D/g, "");
    const virtualEmail = profile.email || `${digits}@noapp.welile.user`;

    // 3. Locate auth user (by id we already have)
    const { data: authUser } = await admin.auth.admin.getUserById(profile.id);

    if (authUser?.user) {
      // A tracking URL is shareable and must never act as a password-reset link.
      // Accounts that have already completed this claim flow (or have signed in)
      // must use the normal account recovery flow instead.
      if (authUser.user.user_metadata?.business_advance_claimed_at || authUser.user.last_sign_in_at) {
        return new Response(JSON.stringify({ error: "This account is already active. Please sign in or reset your password." }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Require fresh proof that the caller controls the phone in the shared
      // tracking link. Consume the verification before changing credentials so
      // the same OTP cannot be replayed in a second claim request.
      const phoneKey = phone.replace(/\D/g, "").slice(-9);
      const verifiedAfter = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data: consumedProof, error: proofError } = await admin
        .from("otp_verifications")
        .update({ verified: false })
        .eq("phone", phoneKey)
        .eq("verified", true)
        .gte("verified_at", verifiedAfter)
        .select("phone")
        .maybeSingle();

      if (proofError || !consumedProof) {
        return new Response(JSON.stringify({ error: "Verify the SMS code sent to this phone before activating the account." }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Set the password the applicant chose + confirm email so they can sign in.
      const update: Record<string, unknown> = {
        password,
        email_confirm: true,
        user_metadata: {
          ...(authUser.user.user_metadata || {}),
          ...(fullName && !authUser.user.user_metadata?.full_name ? { full_name: fullName } : {}),
          business_advance_claimed_at: new Date().toISOString(),
        },
      };
      const { error: upErr } = await admin.auth.admin.updateUserById(profile.id, update);
      if (upErr) throw upErr;
    } else {
      // A profile without its matching auth identity is an integrity issue. Do
      // not create a different user id and silently disconnect the advance.
      return new Response(JSON.stringify({ error: "Account setup is unavailable. Please contact Welile support." }), {
        status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Keep profile full name in sync if applicant supplied one
    if (fullName) {
      await admin.from("profiles").update({ full_name: fullName }).eq("id", profile.id);
    }

    return new Response(JSON.stringify({ email: virtualEmail, user_id: profile.id }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[claim-business-advance-account]", e);
    return new Response(JSON.stringify({ error: (e as Error).message || "Server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
