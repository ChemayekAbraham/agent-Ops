import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Rate limiting
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000;
const activationAttempts = new Map<string, { attempts: number; lastAttempt: number; lockedUntil?: number }>();

function checkRateLimit(token: string): { allowed: boolean; lockedUntil?: number } {
  const now = Date.now();
  const record = activationAttempts.get(token);
  if (!record) return { allowed: true };
  if (record.lockedUntil && now < record.lockedUntil) return { allowed: false, lockedUntil: record.lockedUntil };
  if (record.lockedUntil && now >= record.lockedUntil) { activationAttempts.delete(token); return { allowed: true }; }
  if (now - record.lastAttempt > LOCKOUT_DURATION_MS) { activationAttempts.delete(token); return { allowed: true }; }
  return { allowed: record.attempts < MAX_ATTEMPTS };
}

function recordFailedAttempt(token: string): void {
  const now = Date.now();
  const record = activationAttempts.get(token) || { attempts: 0, lastAttempt: now };
  record.attempts++;
  record.lastAttempt = now;
  if (record.attempts >= MAX_ATTEMPTS) record.lockedUntil = now + LOCKOUT_DURATION_MS;
  activationAttempts.set(token, record);
}

function validateToken(token: unknown): string | null {
  if (typeof token !== 'string') return null;
  const cleaned = token.trim();
  if (cleaned.length < 10 || cleaned.length > 100) return null;
  if (!/^[a-zA-Z0-9-]+$/.test(cleaned)) return null;
  return cleaned;
}

function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return null;
  const cleaned = password.trim();
  if (cleaned.length < 4 || cleaned.length > 100) return null;
  return cleaned;
}

/** Canonical email normalization: trim whitespace + lowercase. Used everywhere we compare or persist emails. */
function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * Normalize a phone number to bare E.164 digits (e.g. "256759229748"), or
 * return null when it can't be made into a valid Ugandan/international number.
 * The `profiles` table has a phone-validation trigger that ABORTS the whole
 * transaction (and thus fails account creation with an empty {} error) on an
 * invalid phone. Passing null keeps activation working when an invite was
 * created with a malformed number (e.g. "078500000").
 */
function normalizePhoneForStorage(raw: unknown): string | null {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('256')) {
    // already international
  } else if (digits.startsWith('0')) {
    digits = `256${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `256${digits}`;
  }
  return /^256[3-9][0-9]{8}$/.test(digits) ? digits : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Registration is active
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    let body: unknown;
    try { body = await req.json(); } catch {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { 
      token: rawToken, 
      password: rawPassword,
      // New fields the user provides during activation
      fullName: userFullName,
      email: userEmail,
      newPassword: userNewPassword,
    } = body as Record<string, unknown>;

    const token = validateToken(rawToken);
    const password = validatePassword(rawPassword);

    if (!token || !password) {
      return new Response(JSON.stringify({ error: "Invalid activation link or password" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Rate limit check
    const rateCheck = checkRateLimit(token);
    if (!rateCheck.allowed) {
      const remainingMinutes = Math.ceil((rateCheck.lockedUntil! - Date.now()) / 60000);
      return new Response(JSON.stringify({ error: `Too many failed attempts. Try again in ${remainingMinutes} minutes.` }), {
        status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Find the invite
    const { data: invite, error: inviteError } = await adminClient
      .from("supporter_invites")
      .select("*")
      .eq("activation_token", token)
      .eq("status", "pending")
      .single();

    if (inviteError || !invite) {
      // Check if already activated
      const { data: activatedInvite } = await adminClient
        .from("supporter_invites")
        .select("id, email, role, status")
        .eq("activation_token", token)
        .eq("status", "activated")
        .single();

      if (activatedInvite) {
        return new Response(JSON.stringify({
          success: true, alreadyActivated: true,
          message: "Account already activated. You can log in.",
          email: activatedInvite.email, role: activatedInvite.role || 'supporter', isSubAgent: false,
        }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      recordFailedAttempt(token);
      return new Response(JSON.stringify({ error: "Invalid or expired activation link" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check expiration (30 days)
    const createdAt = new Date(invite.created_at).getTime();
    if (Date.now() > createdAt + (30 * 24 * 60 * 60 * 1000)) {
      return new Response(JSON.stringify({ error: "Activation link has expired. Please request a new invite." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Verify temp password
    const passwordValid = invite.temp_password && password === String(invite.temp_password).trim();
    if (!passwordValid) {
      recordFailedAttempt(token);
      return new Response(JSON.stringify({ error: "Invalid activation credentials" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Use user-provided details if available, fall back to invite data (with validation)
    let finalFullName = invite.full_name;
    if (typeof userFullName === 'string') {
      const cleaned = userFullName.trim();
      if (cleaned.length >= 2 && cleaned.length <= 100 && /^[\p{L}\p{M}\s'.-]+$/u.test(cleaned)) {
        finalFullName = cleaned;
      }
    }
    
    // Use user-provided email if available, otherwise use invite email.
    // Always normalize (trim + lowercase) — both sides — to prevent casing/whitespace mismatches downstream.
    let finalEmail = normalizeEmail(invite.email);
    if (typeof userEmail === 'string') {
      const cleaned = normalizeEmail(userEmail);
      if (cleaned.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned) && !cleaned.endsWith('@welile.user')) {
        finalEmail = cleaned;
      }
    }

    // Use user's new password if provided, otherwise use the temp password
    const finalPassword = (typeof userNewPassword === 'string' && userNewPassword.trim().length >= 6 && userNewPassword.trim().length <= 128) 
      ? userNewPassword.trim() 
      : password;

    const userRole = invite.role || 'supporter';

    // The profiles phone trigger rejects malformed numbers and aborts the whole
    // account-creation transaction. Normalize once; store null when invalid.
    const safePhone = normalizePhoneForStorage(invite.phone);

    // Check if the creator is an agent (for sub-agent creation)
    let isSubAgent = false;
    let parentAgentId: string | null = null;
    
    if (userRole === 'agent') {
      const { data: creatorRoles } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", invite.created_by)
        .eq("role", "agent")
        .single();
      
      if (creatorRoles) {
        isSubAgent = true;
        parentAgentId = invite.created_by;
      }
    }

    // Create the user account with final details
    let userId: string;
    // createUser can fail with a transient AuthRetryableFetchError (empty
    // message, status 500) when the auth server is briefly unreachable. Retry
    // a few times with backoff before surfacing the error.
    let authData: any = null;
    let authError: any = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      const res = await adminClient.auth.admin.createUser({
        email: finalEmail,
        password: finalPassword,
        email_confirm: true,
        user_metadata: {
          full_name: finalFullName,
          phone: safePhone,
          role: userRole,
          referrer_id: invite.created_by,
        },
      });
      authData = res.data;
      authError = res.error;
      const isRetryable = authError?.name === 'AuthRetryableFetchError' || authError?.status === 500;
      if (!authError || !isRetryable) break;
      console.warn(`[activate-supporter] createUser transient failure (attempt ${attempt}):`, authError?.name);
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 500));
    }

    if (authError) {
      // If email already exists, look up the existing user and proceed
      if (authError.message?.includes('already been registered') || (authError as any).code === 'email_exists') {
        console.log("[activate-supporter] Email exists, looking up existing user for:", finalEmail);
        // listUsers() is paginated (default 50 per page) — scan pages until we find the email.
        // Without pagination we got false 404s for any user past page 1.
        let existingUser: any = null;
        const PER_PAGE = 1000; // max allowed by GoTrue
        for (let page = 1; page <= 50 && !existingUser; page++) {
          const { data: listData, error: listError } = await adminClient.auth.admin.listUsers({ page, perPage: PER_PAGE });
          if (listError) {
            console.error("[activate-supporter] Failed to list users (page", page, "):", listError);
            return new Response(JSON.stringify({ error: "Failed to find existing account" }), {
              status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          existingUser = listData.users.find((u: any) => normalizeEmail(u.email) === finalEmail);
          if (existingUser) break;
          if (!listData.users || listData.users.length < PER_PAGE) break; // last page
        }
        // Fallback: look up by email in profiles table (in case auth lookup still misses)
        if (!existingUser) {
          const { data: profileMatch } = await adminClient
            .from("profiles")
            .select("id")
            .ilike("email", finalEmail) // ilike already case-insensitive; finalEmail is also normalized
            .maybeSingle();
          if (profileMatch?.id) {
            const { data: byId } = await adminClient.auth.admin.getUserById(profileMatch.id);
            if (byId?.user) existingUser = byId.user;
          }
        }
        if (!existingUser) {
          return new Response(JSON.stringify({ error: "Email registered but user not found" }), {
            status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        userId = existingUser.id;
        // Update their password and metadata
        await adminClient.auth.admin.updateUserById(userId, {
          password: finalPassword,
          email_confirm: true,
          user_metadata: {
            full_name: finalFullName,
            phone: safePhone,
            role: userRole,
            referrer_id: invite.created_by,
          },
        });
        console.log("[activate-supporter] Linked to existing auth user:", userId);
      } else {
        console.error("[activate-supporter] Auth error:", authError);
        const detail = authError.message || authError.name || "auth service unavailable, please try again";
        return new Response(JSON.stringify({ error: "Failed to create account: " + detail }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      userId = authData.user.id;
    }

    // Ensure profile exists (trigger may not fire if auth user already existed)
    const { error: profileError } = await adminClient
      .from("profiles")
      .upsert({
        id: userId,
        full_name: finalFullName,
        phone: safePhone,
        email: finalEmail,
        verified: true,
      }, { onConflict: 'id' });
    if (profileError) {
      console.error("[activate-supporter] Profile upsert error:", profileError);
    } else {
      console.log("[activate-supporter] Profile ensured for user:", userId);

      if (invite.created_by) {
        const { error: referrerLinkError } = await adminClient
          .from("profiles")
          .update({ referrer_id: invite.created_by })
          .eq("id", userId);

        if (referrerLinkError) {
          console.error("[activate-supporter] Referrer link error:", referrerLinkError);
        }
      }
    }

    // Ensure wallet exists
    const { error: walletError } = await adminClient
      .from("wallets")
      .upsert({ user_id: userId, balance: 0 }, { onConflict: 'user_id' });
    if (walletError) console.error("[activate-supporter] Wallet upsert error:", walletError);

    // Grant ALL 4 public roles so link-onboarded users can access every public dashboard.
    // The intended role from the invite is preserved in user_metadata for landing-page routing.
    const PUBLIC_ROLES = ['tenant', 'agent', 'landlord', 'supporter'] as const;
    const { error: roleError } = await adminClient
      .from("user_roles")
      .upsert(
        PUBLIC_ROLES.map(role => ({ user_id: userId, role, enabled: true })),
        { onConflict: 'user_id,role' }
      );
    if (roleError) {
      console.error("[activate-supporter] Multi-role upsert error:", roleError);
    } else {
      console.log("[activate-supporter] Granted all 4 public roles to:", userId);
    }
    // Record intended role for default-dashboard routing
    await adminClient.auth.admin.updateUserById(userId, {
      user_metadata: {
        full_name: finalFullName,
        phone: safePhone,
        role: userRole,
        intended_role: userRole,
        referrer_id: invite.created_by,
      },
    });

    // If landlord, create landlord record
    if (userRole === 'landlord') {
      const { error: landlordError } = await adminClient
        .from("landlords")
        .insert({
          name: finalFullName,
          phone: safePhone,
          property_address: invite.property_address || 'Address not provided',
          latitude: invite.latitude || null,
          longitude: invite.longitude || null,
          location_captured_at: invite.latitude ? new Date().toISOString() : null,
          location_captured_by: invite.created_by,
          registered_by: invite.created_by,
        });
      if (landlordError) console.error("[activate-supporter] Landlord error:", landlordError);
    }

    // If sub-agent, create relationship
    if (isSubAgent && parentAgentId) {
      const { error: subAgentError } = await adminClient
        .from("agent_subagents")
        .insert({ parent_agent_id: parentAgentId, sub_agent_id: userId, source: 'invite' });
      if (subAgentError) console.error("[activate-supporter] Sub-agent error:", subAgentError);

      // Sub-agent registration bonus (UGX 3,000) is now awarded automatically
      // by the trg_award_subagent_commission trigger on agent_subagents insert.
      // No manual RPC call needed here.
    }

    // Update invite - store the final email used
    await adminClient
      .from("supporter_invites")
      .update({
        status: "activated",
        activated_at: new Date().toISOString(),
        activated_user_id: userId,
        temp_password: null,
        full_name: finalFullName,
        email: finalEmail,
      })
      .eq("id", invite.id);

    // If an agent assigned this tenant to an empty house at registration, link it
    // now. Only fills a still-empty house (placement bonus trigger fires on the
    // first tenant_id). Best-effort — never blocks activation.
    if (invite.house_listing_id && invite.role === 'tenant') {
      const { error: houseLinkError } = await adminClient
        .from("house_listings")
        .update({ tenant_id: userId, status: "occupied" })
        .eq("id", invite.house_listing_id)
        .is("tenant_id", null);
      if (houseLinkError) {
        console.error("[activate-supporter] House link error:", houseLinkError);
      } else {
        console.log("[activate-supporter] Linked house to tenant:", invite.house_listing_id);
      }

      // Audit trail: record who assigned the house, when, and the placement
      // bonus trigger status. Best-effort — never blocks activation.
      try {
        const { data: listingAfter } = await adminClient
          .from("house_listings")
          .select("agent_id, tenant_id, placement_bonus_paid_at")
          .eq("id", invite.house_listing_id)
          .single();

        // Resolve the role of whoever assigned the house (the invite creator).
        let assignerRole: string | null = null;
        if (invite.created_by) {
          const { data: assignerRoles } = await adminClient
            .from("user_roles")
            .select("role")
            .eq("user_id", invite.created_by);
          assignerRole = assignerRoles?.map((r) => r.role).join(", ") || null;
        }

        let bonusStatus = "unknown";
        if (houseLinkError) {
          bonusStatus = "assignment_failed";
        } else if (listingAfter?.tenant_id !== userId) {
          // House was already occupied — this activation did not fill it.
          bonusStatus = "not_assigned";
        } else if (!listingAfter?.agent_id) {
          bonusStatus = "no_listing_agent";
        } else if (listingAfter?.placement_bonus_paid_at) {
          bonusStatus = "paid";
        } else {
          bonusStatus = "not_paid";
        }

        await adminClient.from("house_assignment_audit").insert({
          house_listing_id: invite.house_listing_id,
          tenant_id: userId,
          invite_id: invite.id,
          assigned_by_user_id: invite.created_by ?? null,
          assigned_by_role: assignerRole,
          listing_agent_id: listingAfter?.agent_id ?? null,
          placement_bonus_status: bonusStatus,
          placement_bonus_paid_at: listingAfter?.placement_bonus_paid_at ?? null,
        });
        console.log("[activate-supporter] House assignment audit recorded:", bonusStatus);
      } catch (auditErr) {
        console.error("[activate-supporter] House assignment audit error:", auditErr);
      }
    }

    // Link investor portfolios created for this invite to the new user
    if (invite.id) {
      // Get portfolios before updating to capture their IDs
      const { data: linkedPortfolios } = await adminClient
        .from("investor_portfolios")
        .select("id, investment_amount, portfolio_code")
        .eq("invite_id", invite.id)
        .is("investor_id", null);

      const { error: portfolioLinkError } = await adminClient
        .from("investor_portfolios")
        .update({ investor_id: userId })
        .eq("invite_id", invite.id)
        .is("investor_id", null);
      if (portfolioLinkError) {
        console.error("[activate-supporter] Portfolio link error:", portfolioLinkError);
      } else {
        console.log("[activate-supporter] Linked portfolios for invite:", invite.id);
        
        // Link pending_wallet_operations to the new user_id so credits go through approval
        // DO NOT credit wallet directly — all supporter credits must be approved by manager/COO
        if (linkedPortfolios && linkedPortfolios.length > 0) {
          // Update any pending_wallet_operations that were created with null user_id for this invite
          const portfolioIds = linkedPortfolios.map(p => p.id);
          const { error: pendingLinkError } = await adminClient
            .from("pending_wallet_operations")
            .update({ user_id: userId })
            .in("source_id", portfolioIds)
            .is("user_id", null)
            .eq("status", "pending");
          if (pendingLinkError) {
            console.error("[activate-supporter] Failed to link pending ops:", pendingLinkError);
          }

          // Also check for pending ops already assigned to this user (agent pre-set partner_id)
          // No action needed — they already have the correct user_id

          for (const portfolio of linkedPortfolios) {
            console.log("[activate-supporter] Portfolio", portfolio.portfolio_code, "linked. Credit pending manager/COO approval.");
          }
        }
      }
    }

    if (invite.created_by) {
      const referralBonus = isSubAgent ? 0 : 500;

      const { error: referralError } = await adminClient
        .from("referrals")
        .upsert({
          referrer_id: invite.created_by,
          referred_id: userId,
          bonus_amount: referralBonus,
          credited: referralBonus > 0,
        }, { onConflict: 'referred_id' });

      if (referralError) {
        console.error("[activate-supporter] Referral upsert error:", referralError);
      }
    }

    if (userRole === 'supporter') {
      await adminClient.from("supporter_referrals").insert({
        referrer_id: invite.created_by, referred_id: userId, bonus_amount: 500,
      });
    }

    const roleLabels: Record<string, string> = {
      tenant: 'Tenant', agent: 'Agent', supporter: 'Supporter', landlord: 'Landlord',
    };

    // Notify creator
    await adminClient.from("notifications").insert({
      user_id: invite.created_by,
      title: `🎉 ${isSubAgent ? 'Sub-Agent' : roleLabels[userRole]} Activated!`,
      message: isSubAgent 
        ? `${finalFullName} has joined your team as a sub-agent!`
        : `${finalFullName} has activated their ${userRole} account! You earned UGX 500 referral bonus.`,
      type: "success",
      metadata: { user_id: userId, invite_id: invite.id, role: userRole, is_sub_agent: isSubAgent },
    });

    console.log(`[activate-supporter] Activated ${isSubAgent ? 'sub-agent' : userRole} account for ${finalEmail}`);


    // Notify managers (fire-and-forget)
    fetch(`${supabaseUrl}/functions/v1/notify-managers`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${supabaseServiceKey}` },
      body: JSON.stringify({ title: "💼 Supporter Activated", body: "Activity: supporter activated", url: "/dashboard/manager" }),
    }).catch(() => {});


    return new Response(JSON.stringify({ 
      success: true,
      message: "Account activated successfully!",
      email: finalEmail,
      role: userRole,
      isSubAgent,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[activate-supporter] Error:", errorMessage);
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
