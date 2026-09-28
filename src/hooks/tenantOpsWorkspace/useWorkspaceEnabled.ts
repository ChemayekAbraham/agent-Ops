/**
 * Reads tops_is_workspace_enabled() — the kill switch (docs/TOPS_RULES.md).
 * Extracted from TenantOpsWorkspacePage.tsx so both the standalone
 * /tenant-ops/workspace route and the Tenant Ops Hub's "Workspace" mode read
 * the same flag through one RPC call, not two.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// TODO(schema-types): run `npm run schema:accept-types` once tops_* RPCs are
// generated, then this cast can be dropped in favour of a typed rpc() call.
const anyDb = supabase as any;

async function fetchWorkspaceEnabled(): Promise<boolean> {
  const { data, error } = await anyDb.rpc('tops_is_workspace_enabled');
  return !error && data === true;
}

export function useWorkspaceEnabled() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'workspaceEnabled'],
    queryFn: fetchWorkspaceEnabled,
    staleTime: 60_000,
  });
}
