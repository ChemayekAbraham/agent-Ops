import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type { Communication, CommunicationContent } from '@/lib/crmCommunications';
import type { Json } from '@/integrations/supabase/types';

export async function readCommunication(role: string, id: string): Promise<Communication | null> {
  const { data, error } = await supabase.rpc('crm_communication_inbox', { p_role: role, p_id: id });
  if (error) throw new Error(error.message);
  const rows = data as unknown as Communication[];
  return rows[0] ?? null;
}
export function useCommunicationInbox(role: string | null, enabled: boolean) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['crm-communication-inbox', user?.id, role], enabled: !!user && !!role && enabled,
    queryFn: async () => {
      if (!role) return [];
      const { data, error } = await supabase.rpc('crm_communication_inbox', { p_role: role });
      if (error) throw new Error(error.message);
      return data as unknown as Communication[];
    },
    staleTime: 60_000, gcTime: 0, refetchOnWindowFocus: 'always', refetchInterval: false,
  });
}
export function useCommunicationAcknowledgement(role: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      if (!role) throw new Error('Open an authorised dashboard first');
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
