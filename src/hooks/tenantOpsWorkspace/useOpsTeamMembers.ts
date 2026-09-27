/**
 * The pool of people a work item can be escalated to — anyone holding one of
 * the six tops_ roles (tenant_ops/operations/coo/cfo/ceo/super_admin), the
 * same access model tops_work_items itself is gated on. Read directly from
 * user_roles + profiles (no tops_ RPC needed — this is a name lookup, not a
 * money figure).
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const anyDb = supabase as any;

const OPS_ROLES = ['tenant_ops', 'operations', 'coo', 'cfo', 'ceo', 'super_admin'] as const;

export interface OpsTeamMember {
  id: string;
  name: string;
}

async function fetchOpsTeamMembers(): Promise<OpsTeamMember[]> {
  const { data: roleRows, error: roleError } = await anyDb
    .from('user_roles')
    .select('user_id')
    .in('role', OPS_ROLES);
  if (roleError) throw roleError;

  const ids = Array.from(new Set((roleRows ?? []).map((r: any) => String(r.user_id))));
  if (ids.length === 0) return [];

  const { data: profileRows, error: profileError } = await anyDb
    .from('profiles')
    .select('id, full_name')
    .in('id', ids);
  if (profileError) throw profileError;

  return (profileRows ?? [])
    .map((p: any) => ({ id: String(p.id), name: p.full_name || 'Unnamed' }))
    .sort((a: OpsTeamMember, b: OpsTeamMember) => a.name.localeCompare(b.name));
}

export function useOpsTeamMembers() {
  return useQuery({
    queryKey: ['tenantOpsWorkspace', 'opsTeamMembers'],
    queryFn: fetchOpsTeamMembers,
    staleTime: 300_000,
  });
}
