import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateFullName, mapProfileFullNameDbError, FULL_NAME_ERROR } from "../_shared/validateFullName.ts";
import { guardAgentAssistedSignup, attachAgentSignupUser } from "../_shared/agentSignupGuard.ts";

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
  if (!/^[0-9+\-\s()]+$/.test(c)) return null;
  const digits = c.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return c;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  console.log("[submit-tenant-form] Invoked");

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

    // Validate required fields (shared rules — same message client + DB trigger use)
    const tenantNameCheck = validateFullName(body.full_name);
    if (!tenantNameCheck.valid) return err(tenantNameCheck.error || FULL_NAME_ERROR);
    const full_name = tenantNameCheck.trimmed;
    const phone = validatePhone(body.phone);
    if (!phone) return err("Invalid phone number format.");

    const income_type = body.income_type as string;
    const rent_amount = Number(body.rent_amount) || 0;
    const duration_days = Number(body.duration_days) || 30;
    // Fee fields are NEVER trusted from the client. The DB trigger
    // `enforce_rent_request_formula` recomputes them from rent_amount + duration_days.
    // We pass zeros and let the trigger overwrite.
    // Stage 4B smartphone capture. `smartphone_answer` is the tri-state the
    // agent form now asks for ("YES" | "NO" | "UNKNOWN"); UNKNOWN is a valid
    // answer and must stay one, so agents are never forced to guess.
    //
    // `no_smartphone` is the legacy boolean and is still honoured for older
    // clients, but it cannot express "don't know" — a missing flag used to be
    // indistinguishable from a confirmed smartphone, which is how ~62k
    // profiles ended up looking confirmed when nobody had ever asked.
    const rawSmartphoneAnswer = String(body.smartphone_answer ?? "").trim().toUpperCase();
    const smartphone_answer =
      rawSmartphoneAnswer === "YES" || rawSmartphoneAnswer === "NO" || rawSmartphoneAnswer === "UNKNOWN"
        ? rawSmartphoneAnswer
        : body.no_smartphone === true
        ? "NO"
        : "UNKNOWN";
    const no_smartphone = smartphone_answer === "NO";
    const house_category = (body.house_category as string) || 'single-room';
    const landlordNameCheck = validateFullName(body.landlord_name);
    const landlord_name = landlordNameCheck.valid ? landlordNameCheck.trimmed : null;
    const landlord_phone = validatePhone(body.landlord_phone);
    const property_address = typeof body.property_address === 'string' ? body.property_address.trim() : '';
    const gps_lat = typeof body.gps_lat === 'number' ? body.gps_lat : null;
    const gps_lng = typeof body.gps_lng === 'number' ? body.gps_lng : null;
    const lc1_name = typeof body.lc1_name === 'string' ? body.lc1_name.trim() : '';
    const lc1_phone = typeof body.lc1_phone === 'string' ? body.lc1_phone.trim() : '';
    const lc1_village = typeof body.lc1_village === 'string' ? body.lc1_village.trim() : '';
    const house_photos = Array.isArray(body.house_photos) ? body.house_photos as string[] : [];

    if (!rent_amount || rent_amount <= 0) return err("Rent amount is required");
    if (!landlord_name) return err(`Landlord name: ${landlordNameCheck.error || FULL_NAME_ERROR}`);
    if (!landlord_phone) return err("Invalid landlord phone");
    if (!property_address) return err("Property address is required");
    if (!lc1_name || !lc1_phone || !lc1_village) return err("LC1 Chairperson details are required");

    // --- Create or find tenant ---
    const cleanPhone = phone.trim();
    const digits = cleanPhone.replace(/[^0-9]/g, '');
    const virtualEmail = `${digits}@noapp.welile.user`;
    const last9 = digits.slice(-9);

    const { data: existingByPhone } = await supabaseAdmin
      .from("profiles").select("id").ilike("phone", `%${last9}`);

    let userId: string;
    let isExisting = false;
    let activationToken: string | null = null;
    let createdEmail: string | null = null;
    let createdPassword: string | null = null;

    if (existingByPhone && existingByPhone.length > 0) {
      userId = existingByPhone[0].id;
      isExisting = true;
    } else {
      // Anti-bot guard: this form is unauthenticated (only a shareable token
      // gates it) and a token allows up to 50 submissions over 72 hours with
      // no other throttle -- without this, a script holding one valid token
      // could mass-create fake tenants in seconds. Keyed on the token's own
      // agent_id (already validated above) since there is no logged-in actor
      // to key on. Same server-side burst cap (5/hour, 15/day) as the
      // authenticated register-tenant flow. See
      // docs/HANDOVER/22-signup-entry-points-hardening.md.
      const guard = await guardAgentAssistedSignup(supabaseAdmin as any, {
        req,
        actorUserId: agent_id,
        email: null,
        phone: cleanPhone,
        targetRole: "tenant",
      });
      if (!guard.allowed) {
        return err(guard.reason || "This registration link is temporarily rate-limited. Please try again later.", 429);
      }

      const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";
      const { data: authData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
        email: virtualEmail, password: tempPassword, email_confirm: true,
        // Tenant registration is exempt from the one-account-per-device-per-day
        // rule in handle_new_user: one agent legitimately registers many tenants
        // from one phone. Capped separately by record_agent_assisted_signup at
        // 5/hour and 15/day per device.
        user_metadata: { full_name, phone: cleanPhone, signup_channel: 'agent_assisted' },
      });

      if (createErr) {
        const { data: existingAuthUsers } = await supabaseAdmin.auth.admin.listUsers();
        const existingAuth = existingAuthUsers?.users?.find((u: any) => u.email === virtualEmail);
        if (existingAuth) { userId = existingAuth.id; isExisting = true; }
        else return err(`Failed to create tenant: ${createErr.message}`, 500);
      } else {
        userId = authData.user.id;
        await attachAgentSignupUser(supabaseAdmin as any, guard.attempt_id, userId);
        const { error: profileUpdateErr } = await supabaseAdmin
          .from("profiles")
          .update({ full_name, phone: cleanPhone })
          .eq("id", userId);
        if (profileUpdateErr) {
          // If the DB trigger rejected the name, surface the friendly client-facing message
          const friendly = mapProfileFullNameDbError(profileUpdateErr);
          if (friendly) return err(friendly);
        }
        // Grant all 4 public roles so the tenant can access every public dashboard
        // (tenant, agent, landlord, supporter) once they activate.
        const PUBLIC_ROLES = ["tenant", "agent", "landlord", "supporter"] as const;
        await supabaseAdmin.from("user_roles").upsert(
          PUBLIC_ROLES.map(role => ({ user_id: userId, role, enabled: true })),
          { onConflict: "user_id,role" }
        );
        await supabaseAdmin.from("referrals").upsert({ referrer_id: agent_id, referred_id: userId }, { onConflict: "referrer_id,referred_id" });

        activationToken = crypto.randomUUID();
        await supabaseAdmin.from("supporter_invites").insert({
          full_name, phone: cleanPhone, email: virtualEmail, temp_password: tempPassword,
          activation_token: activationToken, created_by: agent_id, role: "tenant",
          status: "activated", activated_at: new Date().toISOString(), activated_user_id: userId,
        });
        createdEmail = virtualEmail;
        createdPassword = tempPassword;
      }
    }

    // --- Create landlord ---
    const { data: landlord, error: landlordErr } = await supabaseAdmin
      .from("landlords").insert({
        name: landlord_name, phone: landlord_phone, property_address, registered_by: agent_id,
      }).select("id").single();

    if (landlordErr) { console.error("Landlord create error:", landlordErr); return err("Failed to save landlord details", 500); }

    // --- Reuse-or-create LC1 (a phone uniquely identifies one chairperson) ---
    let lc1: { id: string } | null = null;
    {
      const { data: existingLc1 } = await supabaseAdmin
        .from("lc1_chairpersons")
        .select("id")
        .eq("phone", lc1_phone)
        .order("verified", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      if (existingLc1) {
        lc1 = existingLc1;
      } else {
        const { data: newLc1, error: lc1Err } = await supabaseAdmin
          .from("lc1_chairpersons").insert({ name: lc1_name, phone: lc1_phone, village: lc1_village }).select("id").single();
        if (lc1Err || !newLc1) { console.error("LC1 create error:", lc1Err); return err("Failed to save LC1 details", 500); }
        lc1 = newLc1;
      }
    }

    // --- Create rent request ---
    const { data: rentReq, error: rentErr } = await supabaseAdmin
      .from("rent_requests").insert({
        tenant_id: userId!,
        agent_id,
        landlord_id: landlord.id,
        lc1_id: lc1.id,
        rent_amount,
        duration_days,
        access_fee: 0,
        request_fee: 0,
        total_repayment: 0,
        daily_repayment: 0,
        status: "pending",
        house_category,
        tenant_no_smartphone: no_smartphone,
        request_latitude: gps_lat,
        request_longitude: gps_lng,
      } as any).select("id").single();

    if (rentErr) { console.error("Rent request error:", rentErr); return err("Failed to create rent request", 500); }

    // Record the smartphone answer on the profile lifecycle. Only an explicit
    // YES/NO is a confirmation; UNKNOWN is left alone so the profile stays
    // UNKNOWN and gets picked up by SMARTPHONE_DISCOVERY instead of being
    // silently treated as a smartphone owner. Never fails the registration.
    if (userId && smartphone_answer !== "UNKNOWN") {
      const { error: smartphoneErr } = await supabaseAdmin.rpc("set_tenant_smartphone_status", {
        p_tenant_id: userId,
        p_status: smartphone_answer === "YES" ? "CONFIRMED_SMARTPHONE" : "CONFIRMED_FEATURE_PHONE",
        p_source: "ONBOARDING",
      });
      if (smartphoneErr) {
        console.error("[submit-tenant-form] smartphone status write failed:", smartphoneErr.message);
      }
    }

    // --- Upload house photos ---
    if (house_photos.length > 0 && rentReq?.id) {
      const urls: string[] = [];
      for (let i = 0; i < Math.min(house_photos.length, 3); i++) {
        try {
          const base64 = house_photos[i] as string;
          const match = base64.match(/^data:image\/(\w+);base64,(.+)$/);
          if (!match) continue;
          const ext = match[1];
          const raw = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0));
          const path = `${agent_id}/${rentReq.id}/photo_${i}.${ext}`;
          const { error: upErr } = await supabaseAdmin.storage.from("house-images").upload(path, raw, {
            contentType: `image/${ext}`, cacheControl: "86400", upsert: false,
          });
          if (upErr) { console.warn(`Photo ${i} upload failed:`, upErr.message); continue; }
          const { data: urlData } = supabaseAdmin.storage.from("house-images").getPublicUrl(path);
          urls.push(urlData.publicUrl);
        } catch (e) { console.warn(`Photo ${i} error:`, e); }
      }
      if (urls.length > 0) {
        await supabaseAdmin.from("rent_requests").update({ house_image_urls: urls }).eq("id", rentReq.id);
      }
    }

    // Increment token usage
    await supabaseAdmin.from("agent_form_tokens").update({ uses_count: tokenData.uses_count + 1 }).eq("id", tokenData.id);

    console.log(`[submit-tenant-form] Success: tenant=${userId}, rent_request=${rentReq?.id}`);

    return ok({
      success: true,
      tenant_id: userId!,
      rent_request_id: rentReq?.id,
      existing: isExisting,
      // Auto-sign-in credentials (only present for newly-created tenants).
      // For existing users we cannot return their password — the client will
      // show a "you're already registered" message and route them to login.
      auth_email: createdEmail,
      auth_password: createdPassword,
    });

  } catch (error: any) {
    console.error("[submit-tenant-form] Unhandled:", error?.message || error);
    return err(`Service error: ${error?.message || 'Unknown'}`, 500);
  }
});
