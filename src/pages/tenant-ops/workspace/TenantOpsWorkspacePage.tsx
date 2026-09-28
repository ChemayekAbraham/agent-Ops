/**
 * Tenant Ops Workspace — entry page for the new, parallel-source workspace
 * (docs/TOPS_RULES.md). Does its own role check (does not rely on the
 * RoleGuard wrapping this route in App.tsx) and its own feature-flag read,
 * so either check failing renders nothing but a plain unavailable state.
 *
 * 'tenant_ops' is a valid Postgres app_role (used throughout the tops_*
 * migrations' has_role checks) but is not yet in the frontend AppRole union
 * in src/hooks/auth/types.ts — a pre-existing type/DB drift this task does
 * not fix (editing that file is outside the two permitted single-line
 * edits). The check below compares against the raw role strings rather than
 * routing through AppRole, so it still recognises 'tenant_ops' at runtime.
 *
 * The flag read is shared with the Tenant Ops Hub's "Workspace" mode via
 * useWorkspaceEnabled() — one RPC call, not a second inline one per surface.
 */
import { useAuth } from '@/hooks/useAuth';
import { useWorkspaceEnabled } from '@/hooks/tenantOpsWorkspace/useWorkspaceEnabled';
import WorkspaceShell from '@/components/tenant-ops-workspace/WorkspaceShell';

const ALLOWED_ROLES = ['tenant_ops', 'operations', 'coo', 'ceo', 'super_admin'];

function UnavailableState() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 text-center">
      <p className="text-sm text-muted-foreground">This page is not available.</p>
    </div>
  );
}

export default function TenantOpsWorkspacePage() {
  const { roles, loading: authLoading, rolesResolved } = useAuth();
  const { data: enabled, isLoading: flagLoading } = useWorkspaceEnabled();

  if (authLoading || !rolesResolved || flagLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  const hasAccess = (roles ?? []).some((r) => ALLOWED_ROLES.includes(r as string));

  if (!hasAccess || !enabled) {
    return <UnavailableState />;
  }

  return <WorkspaceShell />;
}
