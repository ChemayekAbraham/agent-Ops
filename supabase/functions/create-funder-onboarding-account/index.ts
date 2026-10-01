// Create a funder-onboarding account without sending the generic auth
// confirmation email. This flow is vetted through /partner-onboarding and the
// only user-facing email should be the partnership agreement email generated
// after the client signs in and stores the agreement details.
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const cleanText = (value: string) => value.replace(/[<>]/g, "").replace(/[\u0000-\u001F\u007F]/g, "").trim();

const BodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(8).max(128),
  fullName: z.string().min(2).max(160).transform(cleanText),
  phone: z.string().min(7).max(32).transform(cleanText),
  referrerId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    z.string().regex(UUID_RE).optional(),
  ),
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      const fe = parsed.error.flatten().fieldErrors as Record<string, string[] | undefined>;
      const field = Object.keys(fe)[0];
      const messages: Record<string, string> = {
        email: "Please enter a valid email address.",
        password: "Your password must be at least 8 characters.",
        fullName: "Please enter your full name.",
        phone: "Please check your phone number — it should have at least 7 digits.",
        referrerId: "Your referral link is not valid. Please ask for a new link.",
      };
      return json({ error: messages[field] || "Please check your details and try again.", field }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    const { email, password, fullName, phone, referrerId } = parsed.data;

    // Pre-checks so the user gets a specific reason instead of a generic database error.
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 7) {
      return json({ error: "Please check your phone number — it should have at least 7 digits.", field: "phone" }, 400);
    }
    const last9 = digits.slice(-9);
    const { data: phoneHits } = await admin
      .from("profiles").select("id").ilike("phone", `%${last9}`).limit(5);
    if ((phoneHits || []).length > 0) {
      return json({ error: "This phone number is already registered to another account. Please sign in, or use a different phone number.", field: "phone" }, 409);
    }
    const { data: emailHits } = await admin
      .from("profiles").select("id").ilike("email", email).limit(1);
    if ((emailHits || []).length > 0) {
      return json({ error: "This email is already registered. Please sign in or use another email.", field: "email" }, 409);
    }

    const metadata: Record<string, unknown> = {
      full_name: fullName,
      phone,
      role: "supporter",
      signup_source: "funder-onboarding",
    };
    if (referrerId) metadata.referrer_id = referrerId.toLowerCase();

    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: metadata,
    });

    if (error) {
      const message = error.message || "Could not create account";
      if (/already|registered|exists/i.test(message)) {
        return json({ error: "This email is already registered. Please sign in or use another email.", field: "email" }, 409);
      }
      console.error("[create-funder-onboarding-account] create failed:", JSON.stringify({
        message,
        status: (error as any).status,
        code: (error as any).code,
        name: (error as any).name,
      }));
      if (/database error/i.test(message)) {
        return json({ error: "This phone number or email is already linked to another Welile account. Please sign in, or use a different phone number and email.", code: (error as any).code }, 409);
      }
      if (/password/i.test(message)) {
        return json({ error: "Your password was not accepted. Use at least 8 characters with letters and numbers.", field: "password" }, 400);
      }
      return json({ error: message || "Could not create funder account", code: (error as any).code }, 400);
    }

    const userId = data.user?.id;
    if (!userId) return json({ error: "Account was not created" }, 500);

    // ── Welcome email (server-side, guaranteed) ──────────────────────────────
    // The agreement email is fired later from the client once the contract row
    // is written; that call can silently fail (slow PDF render, tab closed), so
    // the account-creation confirmation MUST be sent here where nothing can
    // interrupt it. Non-blocking: a mail failure never fails account creation.
    try {
      const { error: mailErr } = await admin.functions.invoke("send-transactional-email", {
        body: {
          templateName: "partner-account-created",
          recipientEmail: email,
          templateData: {
            partner_name: fullName,
            partner_email: email,
            partner_reference: `PA-${userId.slice(0, 8).toUpperCase()}`,
            portal_url: "https://welileapp.com/dashboard",
            company_name: "WELILE TECHNOLOGIES LTD",
          },
        },
      });
      if (mailErr) {
        console.error("[create-funder-onboarding-account] welcome email failed:", mailErr.message || mailErr);
      }
    } catch (e) {
      console.error("[create-funder-onboarding-account] welcome email threw:", (e as Error)?.message || e);
    }

    return json({ ok: true, userId, user: { id: userId, email } });
  } catch (e) {
    console.error("[create-funder-onboarding-account] error:", (e as Error)?.message || e);
    return json({ error: "Internal error" }, 500);
  }
});