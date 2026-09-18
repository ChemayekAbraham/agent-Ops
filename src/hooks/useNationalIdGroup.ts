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

export type UnlinkRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export type UnlinkRequest = {
  id: string;
  owner_id: string;
  member_id: string;
  owner_name: string | null;
  member_name: string | null;
  member_phone: string | null;
  nin_masked: string | null;
  reason: string;
  status: UnlinkRequestStatus;
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
};

/**
 * The ID holder asks Finance Operations to remove someone from their ID.
 * The removal only happens once Finance Operations approves it.
 */
export function useRequestNationalIdUnlink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, reason }: { memberId: string; reason: string }) => {
      const { data, error } = await rpc('request_national_id_unlink', {
        p_member_id: memberId,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message ?? 'Could not send that request.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-unlink-requests-mine'] });
      qc.invalidateQueries({ queryKey: ['national-id-group'] });
    },
  });
}

/** My own removal requests, so each person's card can show where it stands. */
export function useMyNationalIdUnlinkRequests(enabled = true) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['national-id-unlink-requests-mine', user?.id],
    enabled: !!user?.id && enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<UnlinkRequest[]> => {
      const { data, error } = await rpc('national_id_unlink_my_requests');
      if (error) throw new Error(error.message);
      return (data ?? []) as UnlinkRequest[];
    },
  });
}

/** Finance Operations queue of ID-removal requests. */
export function useNationalIdUnlinkQueue(status: 'pending' | 'all' = 'pending') {
  return useQuery({
    queryKey: ['national-id-unlink-queue', status],
    staleTime: 15_000,
    queryFn: async (): Promise<UnlinkRequest[]> => {
      const { data, error } = await rpc('national_id_unlink_queue', { p_status: status });
      if (error) throw new Error(error.message);
      return (data ?? []) as UnlinkRequest[];
    },
  });
}

/** Finance Operations approves or refuses; approval performs the removal and the SMS. */
export function useDecideNationalIdUnlink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      requestId,
      approve,
      note,
    }: { requestId: string; approve: boolean; note?: string }) => {
      const { data, error } = await supabase.functions.invoke('national-id-unlink', {
        body: { request_id: requestId, approve, note: note ?? null },
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; error?: string; sms_sent?: boolean; status?: string };
      if (!res.success) throw new Error(res.error ?? 'Could not record that decision.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-unlink-queue'] });
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
