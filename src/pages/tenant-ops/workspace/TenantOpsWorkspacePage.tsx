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
 */
import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import WorkspaceShell from '@/components/tenant-ops-workspace/WorkspaceShell';

// TODO(schema-types): run `npm run schema:accept-types` once tops_* RPCs are
// generated, then this cast can be dropped in favour of a typed rpc() call.
const anyDb = supabase as any;

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
  const [flagLoading, setFlagLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    anyDb.rpc('tops_is_workspace_enabled').then(({ data, error }: { data: unknown; error: unknown }) => {
      if (cancelled) return;
      setEnabled(!error && data === true);
      setFlagLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
