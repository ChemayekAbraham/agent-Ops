import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { communicationInboxAllowed, type Communication, type CommunicationContent } from '@/lib/crmCommunications';
import type { Database, Json } from '@/integrations/supabase/types';

type DbRole = Database['public']['Enums']['app_role'];

/**
 * The inbox RPC raises when `p_role` is not an enabled `user_roles` row.
 * The client role list also contains a synthetic agent, so this checks the
 * database before a one-off read. The polling hook uses `enabledRoles`,
 * which is that same list without the synthetic agent.
 */
async function userHasEnabledRole(role: string): Promise<boolean> {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw new Error(sessionError.message);
  const userId = sessionData.session?.user?.id;
  if (!userId) return false;
  const { data, error } = await supabase
    .from('user_roles')
    .select('role')
    .eq('user_id', userId)
    .eq('role', role as DbRole)
    .eq('enabled', true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !!data;
}

export async function readCommunication(role: string, id: string): Promise<Communication | null> {
  if (!(await userHasEnabledRole(role))) return null;
  const { data, error } = await supabase.rpc('crm_communication_inbox', { p_role: role, p_id: id });
  if (error) throw new Error(error.message);
  const rows = data as unknown as Communication[];
  return rows[0] ?? null;
}
export function useCommunicationInbox(role: string | null, enabled: boolean) {
  const { user, loading, rolesResolved, enabledRoles } = useAuth();
  const allowed = !!user && !loading && rolesResolved && communicationInboxAllowed(role, enabledRoles);
  return useQuery({
    queryKey: ['crm-communication-inbox', user?.id, role], enabled: !!role && enabled && allowed,
    queryFn: async () => {
      if (!role || !communicationInboxAllowed(role, enabledRoles)) return [];
      const { data, error } = await supabase.rpc('crm_communication_inbox', { p_role: role });
      if (error) throw new Error(error.message);
      return data as unknown as Communication[];
    },
    staleTime: 60_000, gcTime: 0, refetchOnWindowFocus: 'always', refetchInterval: false,
  });
}
export function useCommunicationAcknowledgement(role: string | null) {
  const client = useQueryClient();
  const { rolesResolved, enabledRoles } = useAuth();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!role || !rolesResolved || !communicationInboxAllowed(role, enabledRoles)) throw new Error('Open an authorised dashboard first');
      const { data, error } = await supabase.rpc('crm_communication_acknowledge', { p_id: id, p_role: role });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['crm-communication-inbox'] }),
  });
}
export function useCrmCommunicationManager(status: string, offset: number) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['crm-communication-manager', user?.id, status, offset],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('crm_communication_admin_list', { p_status: status, p_offset: offset });
      if (error) throw new Error(error.message);
      return data as unknown as { items: Communication[]; total: number };
    }, staleTime: 30_000,
  });
}
export function useCommunicationAudienceCount(audiences: string[]) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['crm-communication-audience', user?.id, [...audiences].sort()], enabled: audiences.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('crm_communication_audience_count', { p_audiences: audiences });
      if (error) throw new Error(error.message);
      return data;
    }, staleTime: 60_000,
  });
}
export function useManageCommunication() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ action, id, content, reason }: { action: string; id: string | null; content?: CommunicationContent; reason: string }) => {
      const { data, error } = await supabase.rpc('crm_communication_manage', {
        p_action: action, p_id: id ?? undefined, p_content: (content ?? {}) as unknown as Json, p_reason: reason,
      });
      if (error) throw new Error(error.message);
      if (!data || typeof data !== 'object' || Array.isArray(data) || !('id' in data)) throw new Error('The communication was not confirmed. Please retry.');
      return data as unknown as Communication;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['crm-communication-manager'] });
      void client.invalidateQueries({ queryKey: ['crm-communication-inbox'] });
    },
  });
}
