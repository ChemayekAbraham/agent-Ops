/**
 * Who else is attached to my National ID.
 *
 * The server decides what the caller may see: the person whose ID it is sees
 * everyone attached (name, phone, email, photo); anyone merely attached to
 * someone else's ID sees only that person's name and phone. The ID number is
 * masked on the server and masked again here, so it is never shown in full.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{
  data: unknown; error: { message: string } | null;
}>;
const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;

export type NationalIdGroupMember = {
  user_id: string;
  full_name: string | null;
  phone: string | null;
  email?: string | null;
  avatar_url?: string | null;
};

export type NationalIdGroup = {
  found: boolean;
  reason?: string;
  is_owner?: boolean;
  masked_nin?: string | null;
  member_count?: number;
  members?: NationalIdGroupMember[];
  owner?: NationalIdGroupMember | null;
};

/** Keeps a masked value masked even if the payload ever changes shape. */
export function maskNationalId(value?: string | null): string {
  const raw = String(value ?? '').replace(/\s/g, '').toUpperCase();
  if (!raw) return '';
  if (raw.includes('*')) return raw;
  if (raw.length <= 7) return '*'.repeat(raw.length);
  return `${raw.slice(0, 3)}${'*'.repeat(Math.max(raw.length - 7, 1))}${raw.slice(-4)}`;
}

export function useNationalIdGroup(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['national-id-group', user?.id],
    enabled: !!user?.id && enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<NationalIdGroup> => {
      const { data, error } = await rpc('national_id_group_view');
      if (error) throw new Error(error.message);
      return (data ?? { found: false }) as NationalIdGroup;
    },
  });
}

/** The ID holder removes someone from their ID; that person is told by SMS. */
export function useUnlinkFromMyNationalId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, reason }: { memberId: string; reason: string }) => {
      const { data, error } = await supabase.functions.invoke('national-id-unlink', {
        body: { member_id: memberId, reason },
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; error?: string; sms_sent?: boolean };
      if (!res.success) throw new Error(res.error ?? 'Could not remove that person.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-group'] });
    },
  });
}

export type UnlinkNotice = {
  id: string;
  nin_masked: string;
  owner_name: string | null;
  reason: string;
  created_at: string;
};

/** Notices for this account: "you were removed from that National ID". */
export function useNationalIdUnlinkNotices() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['national-id-unlink-notices', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async (): Promise<UnlinkNotice[]> => {
      const { data, error } = await supabase
        .from('national_id_unlink_notices')
        .select('id, nin_masked, owner_name, reason, created_at')
        .is('acknowledged_at', null)
        .order('created_at', { ascending: false })
        .limit(5);
      if (error) throw new Error(error.message);
      return (data ?? []) as UnlinkNotice[];
    },
  });
}

export function useAcknowledgeUnlinkNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await rpc('national_id_unlink_ack', { p_id: id });
      if (error) throw new Error(error.message);
      return true;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-unlink-notices'] });
    },
  });
}
