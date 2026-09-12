import { supabase } from '@/integrations/supabase/client';
import { setCachedRoles } from '@/lib/sessionCache';
import type { AppRole } from './types';
import { getPreferredDefaultRole } from '@/hooks/useAppPreferences';

export const DEFAULT_ROLE: AppRole = 'tenant';
export const DEFAULT_ROLES: AppRole[] = ['tenant'];

/** Standard roles every user should have */
const STANDARD_ROLES: AppRole[] = ['supporter', 'agent', 'tenant', 'landlord'];

/**
 * Deterministic fallback order used when the user has made no explicit choice
 * (no admin-forced role, no device/server preference, no last-used role and no
 * intended role). Database row order is not stable, so relying on it made the
 * post-sign-in landing dashboard arbitrary.
 */
const FALLBACK_ROLE_PRIORITY: AppRole[] = ['tenant', 'agent', 'landlord', 'supporter'];

function pickFallbackRole(userRoles: AppRole[]): AppRole {
  return FALLBACK_ROLE_PRIORITY.find((r) => userRoles.includes(r)) ?? userRoles[0];
}

/**
 * Outcome of a role lookup.
 *
 *   'resolved'   — the database gave a definitive answer (roles, or genuinely none).
 *   'unresolved' — we could not tell (identity check failed, profile unreadable,
 *                  role read errored). Callers MUST NOT treat this as "no roles":
 *                  bouncing a signed-in user to the role picker on a transient
 *                  failure is what produced the "Dashboard not available" screen
 *                  right after a fresh sign-in.
 */
export type RoleFetchStatus = 'resolved' | 'unresolved';

/**
 * Fetch roles from DB, always ensuring 'agent' is included. Auto-creates roles
 * if missing. Retries once on a transient/unresolved outcome, and never blanks
 * the caller's role list on a failure it cannot explain.
 */
export async function fetchUserRoles(
  userId: string,
  currentRole: AppRole | null,
  setRoles: (r: AppRole[]) => void,
  setRole: (r: AppRole) => void,
  setResolved?: (resolved: boolean) => void,
): Promise<RoleFetchStatus> {
  let status = await fetchUserRolesOnce(userId, currentRole, setRoles, setRole);
  if (status === 'unresolved') {
    setResolved?.(false);
    await new Promise((r) => setTimeout(r, 900));
    status = await fetchUserRolesOnce(userId, currentRole, setRoles, setRole);
  }
  setResolved?.(status === 'resolved');
  return status;
}

async function fetchUserRolesOnce(
  userId: string,
  currentRole: AppRole | null,
  setRoles: (r: AppRole[]) => void,
  setRole: (r: AppRole) => void,
): Promise<RoleFetchStatus> {
  try {
    // First verify the user still exists (prevents re-provisioning deleted accounts)
    const { data: { user: authUser }, error: authError } = await supabase.auth.getUser();
    if (authError || !authUser) {
      // Dead session OR a token refresh still in flight right after sign-in.
      // Unknown, not empty — leave the existing roles alone.
      console.warn('[RoleManager] Identity check failed — role state left unresolved');
      return 'unresolved';
    }

    // Fetch ALL roles (including disabled) to prevent re-provisioning
    const { data: allRolesData, error: allError } = await supabase
      .from('user_roles')
      .select('role, enabled')
      .eq('user_id', userId);

    if (allError) {
      console.warn('[RoleManager] Error fetching roles:', allError.message);
      return 'unresolved';
    }

    // Filter to only enabled roles for display
    const data = (allRolesData || []).filter(r => r.enabled === null || r.enabled === true);
    const hasAnyRolesInDb = (allRolesData || []).length > 0;

    if (data && data.length > 0) {
      const userRoles = data.map(r => r.role as AppRole);
      // Note: link-onboarded users now receive all 4 public roles at activation,
      // so we no longer special-case supporter-only accounts here.
      if (!userRoles.includes('agent')) {
        userRoles.unshift('agent');
      }
      setRoles(userRoles);
      setCachedRoles(userRoles);
      
      // Highest priority: admin-set forced_default_role on the profile (follows user across devices)
      let forcedDefault: AppRole | null = null;
      try {
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('forced_default_role')
          .eq('id', userId)
          .maybeSingle();
        const forced = (profileRow as any)?.forced_default_role as AppRole | undefined;
        if (forced && userRoles.includes(forced)) forcedDefault = forced;
      } catch {/* non-blocking */}

      // Active Merchant (Cash-Out) Agents are SOLELY payout operators: their
      // payout console lives on the agent dashboard. Multi-role field agents
      // often have `tenant`/`supporter` first, so without this they'd default
      // to the wrong dashboard and never see the pending withdrawals queue.
      // When they haven't explicitly chosen another role, land them on the
      // agent console. They can still switch roles manually within a session.
      let cashoutDefault: AppRole | null = null;
      if (userRoles.includes('agent')) {
        try {
          const { data: cashoutRow } = await supabase
            .from('cashout_agents')
            .select('id')
            .eq('agent_id', userId)
            .eq('is_active', true)
            .maybeSingle();
          if (cashoutRow) cashoutDefault = 'agent';
        } catch {/* non-blocking */}
      }

      // Then check user's device preference, then last-used role, then intended role
      const preferred = getPreferredDefaultRole();
      const intendedRole = authUser?.user_metadata?.intended_role as AppRole | undefined;
      let lastUsedRole: AppRole | null = null;
      try { lastUsedRole = localStorage.getItem('welile_last_role') as AppRole | null; } catch {}

      // A user has made an explicit role choice when an admin forced one or they
      // set a device preference by hand. For merchant (cash-out) agents we treat
      // the agent console as their home, so a previously auto-selected
      // last-used role does NOT count as an explicit choice — they should always
      // fall back to the payout console.
      const hasDevicePreference =
        !!forcedDefault
        || (preferred !== 'auto' && userRoles.includes(preferred as AppRole));
      const hasExplicitChoice =
        hasDevicePreference
        || (!cashoutDefault && !!lastUsedRole && userRoles.includes(lastUsedRole));

      const defaultForUser =
        forcedDefault
        ?? ((preferred !== 'auto' && userRoles.includes(preferred as AppRole)) ? preferred as AppRole
        // Merchant agents default straight to the agent console (ignoring a
        // stale last-used role) so the pending withdrawals queue is visible.
        : (cashoutDefault
        ?? ((lastUsedRole && userRoles.includes(lastUsedRole)) ? lastUsedRole
        : ((intendedRole && userRoles.includes(intendedRole)) ? intendedRole
        : pickFallbackRole(userRoles)))));

      if (!currentRole || !userRoles.includes(currentRole)) {
        setRole(defaultForUser);
      } else if (cashoutDefault && !hasExplicitChoice && currentRole !== 'agent') {
        // Active merchant agent with no explicit choice landed on the generic
        // default persona (e.g. supporter). Route them to the payout console so
        // the pending withdrawals queue is visible.
        setRole('agent');
      }
      return 'resolved';
    } else if (!hasAnyRolesInDb) {
      // Only auto-provision if user has NO roles at all in DB (not even disabled ones)
      // If profile doesn't exist, the user is being deleted — do NOT re-provision
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', userId)
        .maybeSingle();

      if (profileError || !profile) {
        // Either the account really is gone, or the profile read failed at this
        // instant. We cannot tell the two apart, so report unresolved and leave
        // whatever roles the caller already holds untouched.
        console.warn('[RoleManager] Profile unreadable — role state left unresolved');
        return 'unresolved';
      }


      console.log('[RoleManager] No roles found, checking user metadata for:', userId);
      
      const intendedRole = authUser?.user_metadata?.intended_role;
      
      // Single-role provisioning: assign only the intended role
      const validSingleRoles: AppRole[] = ['tenant', 'agent', 'landlord', 'supporter'];
      const rolesToCreate: AppRole[] = (intendedRole && validSingleRoles.includes(intendedRole as AppRole))
        ? [intendedRole as AppRole]
        : STANDARD_ROLES; // Backwards compat: no intended_role → all 4
      
      const inserts = rolesToCreate.map(role => ({
        user_id: userId,
        role,
        enabled: true,
      }));
      const { error: insertError } = await supabase
        .from('user_roles')
        .insert(inserts);

      if (!insertError) {
        setRoles(rolesToCreate);
        setCachedRoles(rolesToCreate);
        const defaultRole = intendedRole === 'supporter' ? 'supporter' : 'agent';
        if (!currentRole || !rolesToCreate.includes(currentRole as AppRole)) {
          setRole(defaultRole as AppRole);
        }
        return 'resolved';
      }
      console.warn('[RoleManager] Failed to auto-create roles:', insertError.message);
      return 'unresolved';
    } else {
      // All roles exist but are disabled — user has been fully restricted.
      // This is the ONE case where an empty role list is the truth.
      console.warn('[RoleManager] All roles disabled for user:', userId);
      setRoles([]);
      setRole(null as unknown as AppRole);
      setCachedRoles([]);
      return 'resolved';
    }
  } catch (err: any) {
    console.warn('[RoleManager] Exception fetching roles:', err?.message);
    return 'unresolved';
  }
}

/** Add a new role for the current user. */
export async function addRoleForUser(
  userId: string,
  newRole: AppRole,
  currentRoles: AppRole[],
  currentRole: AppRole | null,
  setRoles: (r: AppRole[]) => void,
  setRole: (r: AppRole) => void,
) {
  if (currentRoles.includes(newRole)) return { error: null };

  // Try to re-enable an existing disabled role first
  const { data: existing } = await supabase
    .from('user_roles')
    .select('id, enabled')
    .eq('user_id', userId)
    .eq('role', newRole)
    .maybeSingle();

  let error;
  if (existing) {
    // Role exists but is disabled — re-enable it
    ({ error } = await supabase
      .from('user_roles')
      .update({ enabled: true })
      .eq('id', existing.id));
  } else {
    // Brand new role
    ({ error } = await supabase
      .from('user_roles')
      .insert({ user_id: userId, role: newRole, enabled: true }));
  }

  if (!error) {
    const updated = [...currentRoles, newRole];
    setRoles(updated);
    if (!currentRole) setRole(newRole);
  }
  return { error: error as Error | null };
}
