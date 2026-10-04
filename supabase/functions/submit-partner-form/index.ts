import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateFullName, FULL_NAME_ERROR } from "../_shared/validateFullName.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function ok(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
function err(msg: string, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function validatePhone(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim();
  if (c.length < 7 || c.length > 20) return null;
  const digits = c.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return c;
}

function validateEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const c = v.trim().toLowerCase();
  if (c.length < 5 || c.length > 255) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return null;
  return c;
}

const ROI_RATE = 0.15;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  console.log("[submit-partner-form] Invoked");

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return err("Invalid request body"); }

    const { token, agent_id } = body;
    if (!token || typeof token !== 'string') return err("Missing or invalid token");
    if (!agent_id || typeof agent_id !== 'string') return err("Missing agent ID");

    // Validate token
    const { data: tokenData, error: tokenErr } = await supabaseAdmin
      .from("agent_form_tokens").select("*")
      .eq("token", token).eq("agent_id", agent_id).eq("is_active", true).maybeSingle();

    if (tokenErr || !tokenData) return err("Invalid or expired link");
    if (new Date(tokenData.expires_at) < new Date()) return err("This link has expired");
    if (tokenData.uses_count >= tokenData.max_uses) return err("This link has reached its usage limit");

    // Validate fields (shared rules — same message client + DB trigger use)
    const partnerNameCheck = validateFullName(body.full_name);
    if (!partnerNameCheck.valid) return err(partnerNameCheck.error || FULL_NAME_ERROR);
    const fullName = partnerNameCheck.trimmed;

    const phone = validatePhone(body.phone);
    if (!phone) return err("Valid phone number is required");

    const email = validateEmail(body.email);
    if (!email) return err("Valid email address is required");

    const residence = typeof body.residence === 'string' ? body.residence.trim() : '';
    if (!residence || residence.length < 2) return err("Residence/location is required");

    const investmentAmount = typeof body.investment_amount === 'number' ? body.investment_amount : 0;
    if (investmentAmount < 100000) return err("Minimum investment is UGX 100,000");

    const payoutMethod = typeof body.payout_method === 'string' ? body.payout_method : '';
    if (!['mobile_money', 'airtel_money', 'bank_transfer'].includes(payoutMethod)) return err("Invalid payout method");

    // Validate conditional payout fields
    let bankName: string | null = null;
    let accountName: string | null = null;
    let accountNumber: string | null = null;
    let mobileNetwork: string | null = null;
    let mobileMoneyNumber: string | null = null;

    if (payoutMethod === 'bank_transfer') {
      bankName = typeof body.bank_name === 'string' ? body.bank_name.trim() : '';
      accountName = typeof body.account_name === 'string' ? body.account_name.trim() : '';
      accountNumber = typeof body.account_number === 'string' ? body.account_number.trim() : '';
      if (!bankName || !accountName || !accountNumber) return err("Bank details are required for bank transfer");
    } else {
      mobileNetwork = typeof body.mobile_network === 'string' ? body.mobile_network : payoutMethod;
      mobileMoneyNumber = typeof body.mobile_money_number === 'string' ? body.mobile_money_number.trim() : '';
      if (!mobileMoneyNumber) return err("Mobile money number is required");
    }

    // Server-side ROI calculation (never trust frontend)
    const monthlyRoi = Math.round(investmentAmount * ROI_RATE);

    // Increment token usage
    await supabaseAdmin
      .from("agent_form_tokens")
      .update({ uses_count: tokenData.uses_count + 1 })
      .eq("id", tokenData.id);

    // ── Provision auth user immediately (auto-sign-up) ─────────────────────
    // Match tenant flow: phone-based virtual email when phone is provided,
    // else use the supplied email. Look up existing accounts by phone-last-9
    // and by email so we don't double-create.
    const cleanPhone = phone.trim();
    const phoneDigits = cleanPhone.replace(/[^0-9]/g, '');
    const last9 = phoneDigits.slice(-9);

    // Prefer the real email the partner submitted; fall back to virtual if missing
    const loginEmail = email;

    let userId: string | null = null;
    let isExisting = false;
    let createdPassword: string | null = null;

    // Check for existing profile by phone or email
    const { data: existingByPhone } = await supabaseAdmin
      .from("profiles").select("id").ilike("phone", `%${last9}`).limit(1);
    if (existingByPhone && existingByPhone.length > 0) {
      userId = existingByPhone[0].id;
      isExisting = true;
    } else {
      const { data: existingAuthUsers } = await supabaseAdmin.auth.admin.listUsers();
      const existingAuth = existingAuthUsers?.users?.find((u: any) => u.email === loginEmail);
      if (existingAuth) {
        userId = existingAuth.id;
        isExisting = true;
      }
    }

    if (!userId) {
      const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";
      const { data: authData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: loginEmail,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { full_name: fullName, phone: cleanPhone },
      });
      if (createErr || !authData?.user) {
        console.error("[submit-partner-form] Auth create error:", createErr?.message);
        return err("Failed to create your account. Please try again.", 500);
      }
      userId = authData.user.id;
      createdPassword = tempPassword;

      await supabaseAdmin.from("profiles").update({ full_name: fullName, phone: cleanPhone }).eq("id", userId);
      const PUBLIC_ROLES = ["tenant", "agent", "landlord", "supporter"] as const;
      await supabaseAdmin.from("user_roles").upsert(
        PUBLIC_ROLES.map(role => ({ user_id: userId, role, enabled: true })),
        { onConflict: "user_id,role" }
      );
      await supabaseAdmin.from("referrals").upsert(
        { referrer_id: agent_id, referred_id: userId },
        { onConflict: "referrer_id,referred_id" }
      );
    }

    const activationToken = crypto.randomUUID();

    // Insert into supporter_invites — already activated
    const { error: insertErr } = await supabaseAdmin
      .from("supporter_invites")
      .insert({
        created_by: agent_id,
        role: 'supporter',
        status: 'activated',
        activated_at: new Date().toISOString(),
        activated_user_id: userId,
        full_name: fullName,
        phone,
        email,
        property_address: residence,
        payment_method: payoutMethod,
        mobile_network: mobileNetwork,
        mobile_money_number: mobileMoneyNumber,
        bank_name: bankName,
        account_name: accountName,
        account_number: accountNumber,
        activation_token: activationToken,
        temp_password: createdPassword ?? '',
      });

    if (insertErr) {
      console.error("[submit-partner-form] Insert error:", insertErr.message);
      return err("Failed to save registration. Please try again.", 500);
    }

    console.log(`[submit-partner-form] Partner registered: ${fullName}, amount=${investmentAmount}, roi=${monthlyRoi}`);

    return ok({
      success: true,
      monthly_roi: monthlyRoi,
      investment_amount: investmentAmount,
      partner_id: userId,
      existing: isExisting,
      // Auto-sign-in credentials (only present for newly-created partners).
      auth_email: createdPassword ? loginEmail : null,
      auth_password: createdPassword,
    });

  } catch (error) {
    console.error("[submit-partner-form] Error:", error?.message || error);
    return err("Service error", 500);
  }
});
