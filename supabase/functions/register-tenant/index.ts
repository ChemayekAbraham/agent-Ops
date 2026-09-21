import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { validateFullName, FULL_NAME_ERROR } from "../_shared/validateFullName.ts";
import { validateUgandaPhone } from "../_shared/ugandaPhone.ts";
import { guardAgentAssistedSignup, attachAgentSignupUser } from "../_shared/agentSignupGuard.ts";
import {
  scoreNameMatch,
  isLikelyDifferentPerson,
  findConsentedDeclaration,
  requestDeclarationConsent,
  confirmDeclarationConsent,
  linkBorrowerProfile,
} from "../_shared/nationalIdDeclaration.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function validatePhone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim();
  if (cleaned.length < 7 || cleaned.length > 20) return null;
  if (!/^[0-9+\-\s()]+$/.test(cleaned)) return null;
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 15) return null;
  return cleaned;
}

function validateNationalId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toUpperCase();
  if (cleaned.length < 10 || cleaned.length > 14) return null;
  if (!/^[A-Z0-9]+$/.test(cleaned)) return null;
  return cleaned;
}

function validateEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned.length > 254) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return null;
  return cleaned;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  console.log("[register-tenant] Function invoked");

  // Tracks resources we created so we can roll them back if a later step fails.
  const rollback = {
    authUserId: null as string | null,
    landlordId: null as string | null,
    lc1Id: null as string | null, // only set when WE created it (not reused)
    rentRequestId: null as string | null,
  };

  let supabaseAdmin: ReturnType<typeof createClient> | null = null;

  async function performRollback(reason: string) {
    console.error(`[register-tenant] Rolling back due to: ${reason}`);
    if (!supabaseAdmin) return;
    try {
      if (rollback.rentRequestId) {
        await supabaseAdmin.from("rent_requests").delete().eq("id", rollback.rentRequestId);
      }
      if (rollback.landlordId) {
        await supabaseAdmin.from("landlords").delete().eq("id", rollback.landlordId);
      }
      if (rollback.lc1Id) {
        await supabaseAdmin.from("lc1_chairpersons").delete().eq("id", rollback.lc1Id);
      }
      if (rollback.authUserId) {
        // Profile/role rows cascade or will be ignored if they reference a missing user;
        // we explicitly clean profile to avoid orphan FK rows.
        await supabaseAdmin.from("profiles").delete().eq("id", rollback.authUserId);
        await supabaseAdmin.from("user_roles").delete().eq("user_id", rollback.authUserId);
        await supabaseAdmin.auth.admin.deleteUser(rollback.authUserId);
      }
    } catch (cleanupErr) {
      console.error("[register-tenant] Rollback partially failed:", cleanupErr);
    }
  }

  try {
    supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Verify the calling user
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.log("[register-tenant] No auth header");
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: { user: callingUser }, error: authErr } = await supabaseAdmin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !callingUser) {
      console.log("[register-tenant] Auth failed:", authErr?.message);
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let body: unknown;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { full_name: rawName, phone: rawPhone, email: rawEmail, national_id: rawNationalId } = body as Record<string, unknown>;
    const landlordPayload = (body as any)?.landlord ?? null;
    const telemetryPayload = (body as any)?.telemetry ?? null;
    const lc1Payload = (body as any)?.lc1 ?? null;
    const rentRequestPayload = (body as any)?.rent_request ?? null;
    console.log("[register-tenant] Input:", { rawName, rawPhone, rawNationalId, hasLandlord: !!landlordPayload });

    const nameCheck = validateFullName(rawName);
    const full_name = nameCheck.valid ? nameCheck.trimmed : null;
    const phone = validatePhone(rawPhone);
    // National ID is OPTIONAL. Only validate when the caller actually provided
    // a non-empty value (e.g. outstanding-balance tenants may not have one yet).
    const rawNidStr = typeof rawNationalId === 'string' ? rawNationalId.trim() : '';
    const national_id = rawNidStr ? validateNationalId(rawNationalId) : null;
    if (rawNidStr && !national_id) {
      return new Response(JSON.stringify({ error: 'Invalid National ID. Must be 10-14 alphanumeric characters.' }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!full_name) {
      return new Response(JSON.stringify({ error: nameCheck.error || FULL_NAME_ERROR }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!phone) {
      return new Response(JSON.stringify({ error: "Invalid phone number format." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const cleanPhone = phone.trim();
    const digits = cleanPhone.replace(/[^0-9]/g, '');
    const last9 = digits.slice(-9);
    const virtualEmail = (rawEmail ? validateEmail(rawEmail) : null) || `${digits}@noapp.welile.user`;

    // ---- National ID borrowing consent gate --------------------------------
    // One account, one national ID, one phone — but sometimes a tenant is
    // registered using a relative's National ID (no ID of their own yet). If
    // the caller supplies national_id_name (the name on the ID) and it does
    // not match this registrant's full_name, the claimed ID owner must
    // confirm by SMS code before the registration proceeds. No-op when
    // national_id_name isn't supplied (existing callers are unaffected).
    let pendingDeclarationId: string | null = null;
    const rawNationalIdName = typeof (body as any)?.national_id_name === 'string' ? (body as any).national_id_name.trim() : '';
    if (national_id && rawNationalIdName) {
      const matchScore = await scoreNameMatch(supabaseAdmin, full_name, rawNationalIdName);
      if (isLikelyDifferentPerson(matchScore)) {
        const alreadyConsented = await findConsentedDeclaration(supabaseAdmin, cleanPhone, national_id);
        if (alreadyConsented) {
          pendingDeclarationId = alreadyConsented.id;
        } else {
          const rawConsentCode = typeof (body as any)?.consent_code === 'string' ? (body as any).consent_code.trim() : '';
          const rawDeclarationId = typeof (body as any)?.consent_declaration_id === 'string' ? (body as any).consent_declaration_id.trim() : '';

          if (rawConsentCode && rawDeclarationId) {
            const result = await confirmDeclarationConsent(supabaseAdmin, rawDeclarationId, rawConsentCode);
            if (!result.ok) {
              return new Response(JSON.stringify({
                error: result.error, code: 'id_owner_consent_required', stage: 'awaiting_code', declaration_id: rawDeclarationId,
              }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            pendingDeclarationId = rawDeclarationId;
          } else {
            const rawIdOwnerPhone = validatePhone((body as any)?.id_owner_phone);
            if (!rawIdOwnerPhone) {
              return new Response(JSON.stringify({
                error: `This National ID appears to belong to ${rawNationalIdName}, not ${full_name}. Enter the ID owner's phone number so we can confirm they've allowed this.`,
                code: 'id_owner_consent_required', stage: 'awaiting_owner_phone',
              }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
            }
            const { data: ownerProfile } = await supabaseAdmin
              .from('profiles').select('id').eq('national_id', national_id).maybeSingle();
            const { declarationId } = await requestDeclarationConsent(supabaseAdmin, {
              borrowerPhone: cleanPhone,
              borrowerFullName: full_name,
              nationalId: national_id,
              nationalIdName: rawNationalIdName,
              idOwnerPhone: rawIdOwnerPhone,
              idOwnerProfileId: (ownerProfile as any)?.id ?? null,
              matchScore,
            });
            return new Response(JSON.stringify({
              error: `We've sent a code to the ID owner's phone. Ask them to share it with you, then resubmit with the same consent_declaration_id and the code.`,
              code: 'id_owner_consent_required', stage: 'awaiting_code', declaration_id: declarationId,
            }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
          }
        }
      }
    }

    // Check if a profile with this phone already exists before National ID conflict handling.
    // Agents often renew Rent Plans for existing tenants; that must reuse the tenant,
    // not fail as a duplicate National ID.
    const { data: existing } = await supabaseAdmin
      .from("profiles")
      .select("id, phone, national_id")
      .eq("phone", cleanPhone)
      .maybeSingle();

    // Also check by normalized last 9 digits
    const { data: existingByLast9 } = await supabaseAdmin
      .from("profiles")
      .select("id, phone, national_id")
      .ilike("phone", `%${last9}`);

    const existingByPhone = existing ?? existingByLast9?.[0] ?? null;

    // Check for duplicate National ID — only when one was provided.
    const existingNationalId = national_id
      ? (await supabaseAdmin
          .from("profiles")
          .select("id, full_name, phone")
          .eq("national_id", national_id)
          .maybeSingle()).data
      : null;

    if (national_id && existingNationalId && (!existingByPhone || existingNationalId.id !== existingByPhone.id)) {
      const nationalDigits = String(existingNationalId.phone ?? '').replace(/\D/g, '');
      if (nationalDigits.slice(-9) !== last9) {
        console.log("[register-tenant] Duplicate national_id found:", existingNationalId.id);
        return new Response(JSON.stringify({ error: `A tenant with this National ID already exists (${existingNationalId.full_name})` }), {
          status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    if (existingByPhone) {
      console.log("[register-tenant] Found existing profile by phone:", existingByPhone.id);
      // Only patch national_id when the caller supplied one and it doesn't conflict.
      if (national_id && (!existingByPhone.national_id || existingByPhone.national_id === national_id)) {
        await supabaseAdmin.from("profiles").update({ national_id, referrer_id: callingUser.id }).eq("id", existingByPhone.id);
      } else {
        await supabaseAdmin.from("profiles").update({ referrer_id: callingUser.id }).eq("id", existingByPhone.id);
      }
      if (pendingDeclarationId) await linkBorrowerProfile(supabaseAdmin, pendingDeclarationId, existingByPhone.id).catch(() => {});
      return new Response(JSON.stringify({ user_id: existingByPhone.id, existing: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if auth user with this email already exists
    const { data: existingAuthUsers } = await supabaseAdmin.auth.admin.listUsers();
    const existingAuth = existingAuthUsers?.users?.find(u => u.email === virtualEmail);
    if (existingAuth) {
      console.log("[register-tenant] Auth user exists with email, reusing:", existingAuth.id);
      // Ensure profile exists
      await supabaseAdmin.from("profiles").upsert({
        id: existingAuth.id,
        full_name,
        phone: cleanPhone,
        email: virtualEmail,
      }, { onConflict: "id" });
      if (pendingDeclarationId) await linkBorrowerProfile(supabaseAdmin, pendingDeclarationId, existingAuth.id).catch(() => {});
      return new Response(JSON.stringify({ user_id: existingAuth.id, existing: true }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ---- Agent Registration Control ---------------------------------------
    // An agent carrying the configured number of active tenants whose previous
    // calendar month collection performance fell below the required level may
    // not take on a NEW tenant until performance recovers or management records
    // an override. Enforced here, at the registration action itself. Existing
    // tenants (renewals) already returned above, so this only gates new people.
    // Fail-open on an unexpected error so registration never breaks outright.
    try {
      const { data: gate, error: gateErr } = await supabaseAdmin.rpc(
        "agent_registration_gate_status",
        { p_agent_id: callingUser.id },
      );
      if (gateErr) {
        console.warn("[register-tenant] Registration gate check failed (allowing):", gateErr.message);
      } else if (gate && (gate as any).blocked) {
        const g = gate as any;
        console.warn("[register-tenant] Blocked by registration control for agent", callingUser.id);
        return new Response(JSON.stringify({
          error: g.reason,
          code: "registration_restricted",
          restriction: {
            active_tenants: g.active_tenants,
            min_active_tenants: g.min_active_tenants,
            previous_month_performance_pct: g.prev_month_pct,
            required_performance_pct: g.required_prev_month_pct,
            period_start: g.period_start,
            period_end: g.period_end,
            previous_month_expected: g.prev_month_expected,
            previous_month_collected: g.prev_month_collected,
          },
        }), {
          status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } catch (gateCatch) {
      console.warn("[register-tenant] Registration gate threw (allowing):", gateCatch);
    }

    // Create auth user with a temp password
    const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";


    // Anti-bot guard: log device fingerprint + true source screen + IP for this
    // agent-assisted registration and enforce the registration burst cap.
    const guard = await guardAgentAssistedSignup(supabaseAdmin as any, {
      req,
      actorUserId: callingUser.id,
      telemetry: telemetryPayload,
      email: virtualEmail,
      phone: cleanPhone,
      targetRole: "tenant",
    });
    if (!guard.allowed) {
      console.warn("[register-tenant] Blocked by anti-bot guard:", guard.status);
      return new Response(JSON.stringify({ error: guard.reason || "Registration temporarily blocked by the anti-bot guard.", status: guard.status }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[register-tenant] Creating auth user with email:", virtualEmail);
    const { data: authData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email: virtualEmail,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name, phone: cleanPhone },
    });

    if (createErr) {
      console.error("[register-tenant] Auth create error:", createErr.message);
      // Race-condition defence: another agent may have just created this tenant.
      // Look up the existing profile by phone and return it gracefully.
      const errMsg = String(createErr.message).toLowerCase();
      if (errMsg.includes("phone_already_registered") || errMsg.includes("23505") || errMsg.includes("unique_violation")) {
        const { data: raced } = await supabaseAdmin
          .from("profiles")
          .select("id, phone, national_id")
          .eq("phone", cleanPhone)
          .maybeSingle();
        if (raced) {
          console.log("[register-tenant] Race won by other request; returning existing:", raced.id);
          return new Response(JSON.stringify({ user_id: raced.id, existing: true }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      }
      return new Response(JSON.stringify({ error: `Failed to create tenant account: ${createErr.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = authData.user.id;
    rollback.authUserId = userId;
    await attachAgentSignupUser(supabaseAdmin as any, guard.attempt_id, userId);
    console.log("[register-tenant] Created auth user:", userId);

    // Update profile (trigger should have created it).
    // Also stamp referrer_id so the agent who registered this tenant can see them
    // under "My Tenants" (which filters by profiles.referrer_id).
    const profileUpdate: Record<string, unknown> = {
      full_name,
      phone: cleanPhone,
      referrer_id: callingUser.id,
    };
    if (national_id) profileUpdate.national_id = national_id;
    const { error: profileErr } = await supabaseAdmin
      .from("profiles")
      .update(profileUpdate)
      .eq("id", userId);
    
    if (profileErr) {
      console.error("[register-tenant] Profile update error:", profileErr.message);
      await performRollback(`profile update: ${profileErr.message}`);
      return new Response(JSON.stringify({ error: `Failed to write tenant profile: ${profileErr.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    if (pendingDeclarationId) await linkBorrowerProfile(supabaseAdmin, pendingDeclarationId, userId).catch(() => {});

    // Assign tenant role
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .upsert({ user_id: userId, role: "tenant", enabled: true }, { onConflict: "user_id,role" });
    
    if (roleErr) {
      console.error("[register-tenant] Role upsert error:", roleErr.message);
      await performRollback(`role assign: ${roleErr.message}`);
      return new Response(JSON.stringify({ error: `Failed to assign tenant role: ${roleErr.message}` }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create referral link between agent and tenant
    await supabaseAdmin
      .from("referrals")
      .upsert({ referrer_id: callingUser.id, referred_id: userId }, { onConflict: "referrer_id,referred_id" })
      .then(({ error }) => {
        if (error) console.log("[register-tenant] Referral upsert (non-critical):", error.message);
      });

    // ---------- Atomic landlord + LC1 + rent_request provisioning ----------
    let createdRentRequestId: string | null = null;

    if (landlordPayload && typeof landlordPayload === 'object') {
      const monthlyRentNum = Number(landlordPayload.monthly_rent);
      if (!Number.isFinite(monthlyRentNum) || monthlyRentNum <= 0) {
        await performRollback('invalid landlord.monthly_rent');
        return new Response(JSON.stringify({ error: 'Invalid monthly rent amount' }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Validate the landlord phone server-side so only dialable Ugandan
      // numbers are stored — this is what later powers the Call / WhatsApp
      // actions, so an invalid number must never reach the table.
      const landlordPhoneCheck = validateUgandaPhone(landlordPayload.phone);
      if (!landlordPhoneCheck.valid || !landlordPhoneCheck.e164) {
        await performRollback('invalid landlord.phone');
        return new Response(JSON.stringify({ error: landlordPhoneCheck.error || 'Invalid landlord phone number' }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: landlordRow, error: landlordErr } = await supabaseAdmin
        .from('landlords')
        .insert({
          tenant_id: userId,
          name: String(landlordPayload.name ?? '').trim(),
          phone: landlordPhoneCheck.e164,
          property_address: String(landlordPayload.property_address ?? '').trim(),
          monthly_rent: monthlyRentNum,
          mobile_money_number: landlordPayload.mobile_money_number ?? null,
          latitude: landlordPayload.latitude ?? null,
          longitude: landlordPayload.longitude ?? null,
          location_captured_at: landlordPayload.latitude ? new Date().toISOString() : null,
          location_captured_by: callingUser.id,
          registered_by: callingUser.id,
        })
        .select('id')
        .single();

      if (landlordErr || !landlordRow) {
        await performRollback(`landlord insert: ${landlordErr?.message}`);
        const msg = landlordErr?.code === '23505'
          ? 'This tenant already has this landlord registered'
          : `Failed to save landlord: ${landlordErr?.message ?? 'unknown'}`;
        return new Response(JSON.stringify({ error: msg }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      rollback.landlordId = landlordRow.id;

      // LC1 (optional): a phone uniquely identifies one chairperson — reuse the
      // existing row (prefer a verified one) when present, otherwise create.
      let lc1Id: string | null = null;
      if (lc1Payload && lc1Payload.name && lc1Payload.phone && lc1Payload.village) {
        const village = String(lc1Payload.village).trim();
        const phone = String(lc1Payload.phone).trim();
        const { data: existingLc1 } = await supabaseAdmin
          .from('lc1_chairpersons')
          .select('id')
          .eq('phone', phone)
          .order('verified', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle();
        if (existingLc1) {
          lc1Id = existingLc1.id;
          // Reused row: attach the official village link if it is still missing.
          if (lc1Payload.village_id) {
            await supabaseAdmin
              .from('lc1_chairpersons')
              .update({
                village,
                ug_village_id: lc1Payload.village_id,
                region: lc1Payload.region ?? null,
                district: lc1Payload.district ?? null,
                county: lc1Payload.county ?? null,
                sub_county: lc1Payload.sub_county ?? null,
                parish: lc1Payload.parish ?? null,
              })
              .eq('id', existingLc1.id)
              .is('ug_village_id', null);
          }
        } else {
          const { data: newLc1, error: lc1Err } = await supabaseAdmin
            .from('lc1_chairpersons')
            .insert({
              name: String(lc1Payload.name).trim(),
              phone,
              village,
              // Approved Uganda dataset link + derived chain (null for legacy typed input).
              ug_village_id: lc1Payload.village_id ?? null,
              region: lc1Payload.region ?? null,
              district: lc1Payload.district ?? null,
              county: lc1Payload.county ?? null,
              sub_county: lc1Payload.sub_county ?? null,
              parish: lc1Payload.parish ?? null,
            })
            .select('id')
            .single();
          if (lc1Err || !newLc1) {
            await performRollback(`lc1 insert: ${lc1Err?.message}`);
            return new Response(JSON.stringify({ error: `Failed to save LC1: ${lc1Err?.message ?? 'unknown'}` }), {
              status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          lc1Id = newLc1.id;
          rollback.lc1Id = newLc1.id;
        }
      }

      // Rent request (the agent earns commission on every payment).
      const rr = rentRequestPayload && typeof rentRequestPayload === 'object' ? rentRequestPayload : {};
      const { data: rentRow, error: rentErr } = await supabaseAdmin
        .from('rent_requests')
        .insert({
          tenant_id: userId,
          agent_id: callingUser.id,
          landlord_id: landlordRow.id,
          lc1_id: lc1Id,
          rent_amount: Number(rr.rent_amount ?? monthlyRentNum),
          duration_days: Number(rr.duration_days ?? 30),
          access_fee: 0,
          request_fee: 0,
          total_repayment: 0,
          daily_repayment: 0,
          status: 'pending',
          house_category: rr.house_category ?? 'single-room',
          request_latitude: rr.request_latitude ?? landlordPayload.latitude ?? null,
          request_longitude: rr.request_longitude ?? landlordPayload.longitude ?? null,
        } as any)
        .select('id')
        .single();

      if (rentErr || !rentRow) {
        await performRollback(`rent_request insert: ${rentErr?.message}`);
        return new Response(JSON.stringify({ error: `Failed to create rent request: ${rentErr?.message ?? 'unknown'}` }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      createdRentRequestId = rentRow.id;
      rollback.rentRequestId = rentRow.id;

      // Activate rent discount on the tenant profile.
      await supabaseAdmin
        .from('profiles')
        .update({ rent_discount_active: true, monthly_rent: monthlyRentNum })
        .eq('id', userId);
    }

    // Create activation invite so the tenant can claim their account later
    const activationToken = crypto.randomUUID();
    const { error: inviteErr } = await supabaseAdmin
      .from("supporter_invites")
      .insert({
        full_name,
        phone: cleanPhone,
        email: virtualEmail,
        temp_password: tempPassword,
        activation_token: activationToken,
        created_by: callingUser.id,
        role: "tenant",
        status: "pending",
      });

    if (inviteErr) {
      console.error("[register-tenant] Invite insert error:", inviteErr.message);
      // Non-critical: tenant was created, invite is just for claiming
    }

    console.log(`[register-tenant] Successfully created tenant ${userId}`);


    // Notify managers (fire-and-forget)
    const fnUrl = Deno.env.get("SUPABASE_URL");
    const fnKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    fetch(`${fnUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${fnKey}` },
      body: JSON.stringify({ title: "👤 Tenant Registered", body: "Activity: new tenant", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({
      user_id: userId,
      existing: false,
      activation_token: activationToken,
      temp_password: tempPassword,
      rent_request_id: createdRentRequestId,
    }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[register-tenant] Unhandled error:", error?.message || error);
    await performRollback(`unhandled: ${error?.message ?? 'unknown'}`);
    return new Response(JSON.stringify({ error: `Service error: ${error?.message || 'Unknown'}` }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
