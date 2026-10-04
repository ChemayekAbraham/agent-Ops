import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const validRoles = ['tenant', 'agent', 'supporter', 'landlord', 'manager'];

// Normalize phone numbers for duplicate checks.
const toDigits = (value: string) => value.replace(/\D/g, "");
const ugLocal9 = (value: string) => {
  const digits = toDigits(value);
  if (!digits) return null;
  const last9 = digits.length >= 9 ? digits.slice(-9) : digits;
  return last9.length === 9 ? last9 : null;
};

// Input validation helpers
function validateFullName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length < 2 || cleaned.length > 100) return null;
  if (!/^[\p{L}\p{M}\s'.-]+$/u.test(cleaned)) return null;
  return cleaned;
}

function validateEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null;
  return cleaned;
}

function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (value.length < 4 || value.length > 128) return null;
  return value;
}

function validatePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length < 7 || cleaned.length > 20) return null;
  if (!/^[0-9+\-\s()]+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return cleaned;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data: roleData } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ["manager", "agent"]);

    if (!roleData || roleData.length === 0) {
      return new Response(JSON.stringify({ error: "Only managers and agents can create user invites" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const creatorRole = roleData[0].role;

    let body: unknown;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawBody = body as Record<string, unknown>;
    console.log("Received request body:", JSON.stringify({ 
      phone: typeof rawBody.phone === 'string' ? rawBody.phone.substring(0, 4) + '***' : undefined, 
      role: rawBody.role,
      isSubAgent: rawBody.isSubAgent 
    }));
    
    const phone = validatePhone(rawBody.phone);
    const password = validatePassword(rawBody.password);
    const role = (typeof rawBody.role === 'string' && validRoles.includes(rawBody.role)) ? rawBody.role : 'tenant';
    const isSubAgent = rawBody.isSubAgent === true;
    const latitude = typeof rawBody.latitude === 'number' && Number.isFinite(rawBody.latitude) ? rawBody.latitude : null;
    const longitude = typeof rawBody.longitude === 'number' && Number.isFinite(rawBody.longitude) ? rawBody.longitude : null;
    const locationAccuracy = typeof rawBody.locationAccuracy === 'number' && Number.isFinite(rawBody.locationAccuracy) ? rawBody.locationAccuracy : null;
    const propertyAddress = typeof rawBody.propertyAddress === 'string' ? rawBody.propertyAddress.trim().slice(0, 500) : 
                           typeof rawBody.address === 'string' ? rawBody.address.trim().slice(0, 500) : null;

    // Optional: an available empty house the agent is assigning this tenant to.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const houseListingId = typeof rawBody.houseListingId === 'string' && uuidRe.test(rawBody.houseListingId.trim())
      ? rawBody.houseListingId.trim()
      : null;

    // fullName and email are optional - validated if present
    let email = rawBody.email ? validateEmail(rawBody.email) : null;
    let fullName = rawBody.fullName ? validateFullName(rawBody.fullName) : null;

    if (!phone) {
      return new Response(JSON.stringify({ error: "Invalid phone number format" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!password) {
      return new Response(JSON.stringify({ error: "Password is required (4-128 characters)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!validRoles.includes(role)) {
      return new Response(JSON.stringify({ error: "Invalid role" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (creatorRole === 'agent' && !['tenant', 'landlord', 'agent', 'supporter'].includes(role)) {
      return new Response(JSON.stringify({ error: "Agents can only create tenant, landlord, sub-agent, and supporter accounts" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (role === 'manager' && creatorRole !== 'manager') {
      return new Response(JSON.stringify({ error: "Only managers can create manager accounts" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const local9 = ugLocal9(phone);
    if (!local9) {
      return new Response(JSON.stringify({ error: "Invalid phone number" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Auto-generate email and fullName if not provided
    if (!email) {
      email = `${phone.replace(/\D/g, '')}@welile.user`;
    }
    if (!fullName) {
      fullName = `User ${phone.replace(/\D/g, '').slice(-4)}`;
    }

    // Check if profile already exists with this phone number using SQL pattern match
    // This handles all phone format variants (0xx, +256xx, 256xx) by matching last 9 digits
    const { data: existingProfileByPhone, error: phoneCheckError } = await adminClient
      .from("profiles")
      .select("id, full_name")
      .or(`phone.like.%${local9},phone.like.%${local9.replace(/^0/, '')}`)
      .neq("id", user.id)
      .limit(1)
      .maybeSingle();

    if (phoneCheckError) {
      console.error("Phone check error:", phoneCheckError);
      // Fallback: try a more targeted query
      const { data: fallbackCheck } = await adminClient.rpc('check_phone_exists', { phone_suffix: local9 }).maybeSingle();
      if (fallbackCheck) {
        return new Response(JSON.stringify({ 
          error: `This phone number is already registered. They can sign in directly.`,
        }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (existingProfileByPhone) {
      return new Response(JSON.stringify({ 
        error: `This phone number is already registered to ${existingProfileByPhone.full_name}. They can sign in directly.`,
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if email already exists (only for non-auto-generated emails)
    if (!email.endsWith('@welile.user')) {
      const { data: existingProfileByEmail } = await adminClient
        .from("profiles")
        .select("id")
        .ilike("email", email)
        .limit(1)
        .maybeSingle();

      if (existingProfileByEmail) {
        return new Response(JSON.stringify({ error: "A user with this email already exists" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Check if a pending invite already exists for this phone (using last 9 digits)
    const { data: pendingInvites } = await adminClient
      .from("supporter_invites")
      .select("id")
      .eq("status", "pending")
      .like("phone", `%${local9}`)
      .limit(1)
      .maybeSingle();

    if (pendingInvites) {
      return new Response(JSON.stringify({ error: "A pending invite for this phone number already exists" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let parentAgentId: string | null = null;
    if (creatorRole === 'agent' && role === 'agent') {
      parentAgentId = user.id;
    }

    // Extract investor-specific fields
    const nationalId = typeof rawBody.national_id === 'string' ? rawBody.national_id.trim().slice(0, 50) : null;
    const invCountry = typeof rawBody.country === 'string' ? rawBody.country.trim().slice(0, 100) : null;
    const districtCity = typeof rawBody.district_city === 'string' ? rawBody.district_city.trim().slice(0, 200) : null;
    const nextOfKinName = typeof rawBody.next_of_kin_name === 'string' ? rawBody.next_of_kin_name.trim().slice(0, 200) : null;
    const nextOfKinRelationship = typeof rawBody.next_of_kin_relationship === 'string' ? rawBody.next_of_kin_relationship.trim().slice(0, 100) : null;
    const nextOfKinPhone = typeof rawBody.next_of_kin_phone === 'string' ? rawBody.next_of_kin_phone.trim().slice(0, 20) : null;
    const invPaymentMethod = typeof rawBody.payment_method === 'string' && ['mobile_money', 'bank'].includes(rawBody.payment_method) ? rawBody.payment_method : null;
    const invMobileNetwork = typeof rawBody.mobile_network === 'string' && ['mtn', 'airtel'].includes(rawBody.mobile_network) ? rawBody.mobile_network : null;
    const invMobileMoneyNumber = typeof rawBody.mobile_money_number === 'string' ? rawBody.mobile_money_number.trim().slice(0, 20) : null;
    const invBankName = typeof rawBody.bank_name === 'string' ? rawBody.bank_name.trim().slice(0, 100) : null;
    const invAccountName = typeof rawBody.account_name === 'string' ? rawBody.account_name.trim().slice(0, 200) : null;
    const invAccountNumber = typeof rawBody.account_number === 'string' ? rawBody.account_number.trim().slice(0, 50) : null;

    // Validate the chosen empty house (tenant flow only): it must exist, be
    // available and not already assigned to a tenant. Best-effort — never blocks
    // registration if the lookup hiccups; just drops the invalid assignment.
    let validHouseListingId: string | null = null;
    if (houseListingId && role === 'tenant') {
      const { data: houseRow } = await adminClient
        .from("house_listings")
        .select("id, tenant_id, status, reserved_by, reserved_at")
        .eq("id", houseListingId)
        .maybeSingle();
      if (houseRow && houseRow.tenant_id) {
        return new Response(JSON.stringify({ error: "That house already has a tenant. Pick another empty house." }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else if (
        houseRow &&
        houseRow.reserved_by &&
        houseRow.reserved_by !== user.id &&
        houseRow.reserved_at &&
        Date.now() - new Date(houseRow.reserved_at).getTime() < 30 * 24 * 60 * 60 * 1000
      ) {
        // Another agent is already holding this house via a pending invite.
        return new Response(JSON.stringify({ error: "That house was just reserved by another agent. Pick another empty house." }), {
          status: 409,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } else if (houseRow && !houseRow.tenant_id && houseRow.status === 'available') {
        validHouseListingId = houseRow.id;
      }
    }

    const { data: invite, error: inviteError } = await adminClient
      .from("supporter_invites")
      .insert({
        email,
        full_name: fullName,
        phone,
        temp_password: password,
        role,
        created_by: user.id,
        parent_agent_id: parentAgentId,
        house_listing_id: validHouseListingId,
        latitude: latitude || null,
        longitude: longitude || null,
        location_accuracy: locationAccuracy || null,
        property_address: propertyAddress || null,
        national_id: nationalId,
        country: invCountry,
        district_city: districtCity,
        next_of_kin_name: nextOfKinName,
        next_of_kin_relationship: nextOfKinRelationship,
        next_of_kin_phone: nextOfKinPhone,
        payment_method: invPaymentMethod,
        mobile_network: invMobileNetwork,
        mobile_money_number: invMobileMoneyNumber,
        bank_name: invBankName,
        account_name: invAccountName,
        account_number: invAccountNumber,
      })
      .select()
      .single();

    if (inviteError) {
      console.error("Invite error:", inviteError);
      
      if (inviteError.code === '23505') {
        // Two agents racing for the same empty house — only one pending invite
        // can hold a house (uniq_pending_invite_house_listing partial index).
        if (inviteError.message?.includes('uniq_pending_invite_house_listing')) {
          return new Response(JSON.stringify({ error: "That house was just reserved by another agent. Pick another empty house." }), {
            status: 409,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const isPhoneDuplicate = inviteError.message?.includes('phone') || 
                                  inviteError.message?.includes('idx_supporter_invites_phone_normalized');
        if (isPhoneDuplicate) {
          return new Response(JSON.stringify({ error: "A user or pending invite with this phone number already exists" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "This invite already exists (duplicate detected)" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      return new Response(JSON.stringify({ error: "Failed to create invite", details: inviteError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Created ${role} invite for ${email} by ${creatorRole} ${user.id}${parentAgentId ? ' (sub-agent)' : ''}`);

    // AUTO-ACTIVATE:
    // 1. When a manager creates an invite (any role) — full fast-track.
    // 2. When an agent registers a sub-agent (creatorRole === 'agent' && role === 'agent')
    //    — sub-agents under an existing agent are auto-approved (no manager review needed).
    let autoActivated = false;
    const isSubAgentAutoActivate = creatorRole === 'agent' && role === 'agent';
    if (creatorRole === 'manager' || isSubAgentAutoActivate) {
      try {
        const { data: authData, error: authError } = await adminClient.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: {
            full_name: fullName,
            phone,
            role,
            referrer_id: user.id,
          },
        });

        if (authError) {
          console.error("Auto-activate auth error:", authError);
        } else if (authData?.user) {
          // Ensure profile exists (handle_new_user trigger may not fire for admin.createUser)
          await adminClient
            .from("profiles")
            .upsert({
              id: authData.user.id,
              full_name: fullName,
              email,
              phone,
              verified: true,
              // Stamp parent agent as referrer for sub-agent fast-track so the
              // sub-agent appears under the parent agent's roster.
              ...(isSubAgentAutoActivate ? { referrer_id: user.id } : {}),
            }, { onConflict: 'id' });

          // Add user role (auto-approved for sub-agent fast-track)
          await adminClient
            .from("user_roles")
            .upsert(
              { user_id: authData.user.id, role, enabled: true },
              { onConflict: 'user_id,role' }
            );

          // Record parent-agent relationship in the referrals table and create
          // the agent_subagents record (auto-verified — no approval needed).
          if (isSubAgentAutoActivate) {
            await adminClient
              .from("referrals")
              .upsert(
                { referrer_id: user.id, referred_id: authData.user.id },
                { onConflict: 'referrer_id,referred_id' }
              );

            await adminClient
              .from("agent_subagents")
              .upsert(
                {
                  parent_agent_id: user.id,
                  sub_agent_id: authData.user.id,
                  source: 'agent_invite',
                  status: 'verified',
                  verified_by: user.id,
                  verified_at: new Date().toISOString(),
                },
                { onConflict: 'sub_agent_id' }
              );
          }

          // If landlord, create landlord record
          if (role === 'landlord') {
            await adminClient
              .from("landlords")
              .insert({
                name: fullName,
                phone,
                property_address: propertyAddress || 'Address not provided',
                latitude: latitude || null,
                longitude: longitude || null,
                location_captured_at: latitude ? new Date().toISOString() : null,
                location_captured_by: user.id,
                registered_by: user.id,
              });
          }

          // Mark invite as activated
          await adminClient
            .from("supporter_invites")
            .update({ status: "activated", activated_at: new Date().toISOString() })
            .eq("id", invite.id);

          autoActivated = true;
          console.log(`Auto-activated ${role} account for ${email} (manager fast-track)`);
        }
      } catch (activateErr: any) {
        console.error("Auto-activate error:", activateErr?.message);
        // Fall through — invite still exists, user can activate manually
      }
    }

    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "👤 Supporter Invited", body: "Activity: supporter invite", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({ 
      success: true, 
      autoActivated,
      invite: {
        id: invite.id,
        activation_token: invite.activation_token,
        email: invite.email,
        full_name: invite.full_name,
        role: invite.role,
        parent_agent_id: parentAgentId,
      }
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("Error creating invite:", error);
    return new Response(JSON.stringify({ 
      error: error.message || "Internal server error",
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
