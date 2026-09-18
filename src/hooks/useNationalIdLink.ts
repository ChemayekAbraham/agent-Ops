/**
 * National ID group linking.
 *
 * When someone photographs a National ID that another account already holds,
 * they can ask to be linked to it. Three things must happen before they may
 * continue: a code sent to the number on the holder's account is entered, the
 * holder answers Yes in the app, and staff confirm the details. The request
 * expires on its own after 7 days.
 *
 * Nothing about the holder is exposed here — the asker only ever sees the ID
 * number they typed themselves.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/** How often the asker's screen re-checks whether the holder has answered. */
export const LINK_POLL_INTERVAL_MS = 25_000;

export type NationalIdLinkStatus =
  | 'awaiting_owner'
  | 'owner_approved'
  | 'active'
  | 'rejected_by_owner'
  | 'rejected_by_staff'
  | 'expired'
  | 'cancelled_by_requester';

export type NationalIdLinkState = {
  found: boolean;
  id?: string;
  nin?: string;
  status?: NationalIdLinkStatus;
  code_sent?: boolean;
  code_verified?: boolean;
  owner_confirmed?: boolean;
  staff_confirmed?: boolean;
  expires_at?: string | null;
  created_at?: string | null;
  decision_reason?: string | null;
};

type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<{
  data: unknown; error: { message: string } | null;
}>;
const rpc = supabase.rpc.bind(supabase) as unknown as Rpc;

export type HolderLinkRequest = {
  id: string;
  nin: string;
  status: NationalIdLinkStatus;
  code_verified_at: string | null;
  created_at: string;
  expires_at: string;
  requester_name: string | null;
  requester_phone: string | null;
};

/** Creates (or picks up) this account's open request for that ID number. */
export function useRequestNationalIdLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (nin: string) => {
      const { data, error } = await rpc('request_national_id_link', { p_nin: nin });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as {
        success?: boolean; message?: string; request_id?: string; status?: NationalIdLinkStatus;
      };
      if (!res.success) throw new Error(res.message ?? 'Could not start that request.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-link-mine'] });
    },
  });
}

/** The requester closes their own open request so they can start again. */
export function useCancelNationalIdLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await rpc('cancel_national_id_link', { p_request_id: requestId });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message ?? 'Could not cancel that request.');
      return res;
    },
    onSuccess: (_d, requestId) => {
      qc.invalidateQueries({ queryKey: ['national-id-link-state', requestId] });
      qc.invalidateQueries({ queryKey: ['national-id-link-mine'] });
      qc.invalidateQueries({ queryKey: ['national-id-link-holder'] });
    },
  });
}

/** The asker's own view of one request, polled while it is still open. */
export function useNationalIdLinkState(requestId: string | null | undefined) {
  return useQuery({
    queryKey: ['national-id-link-state', requestId],
    enabled: !!requestId,
    refetchInterval: (query) => {
      const s = (query.state.data as NationalIdLinkState | undefined)?.status;
      return s === 'awaiting_owner' || s === 'owner_approved' ? LINK_POLL_INTERVAL_MS : false;
    },
    queryFn: async (): Promise<NationalIdLinkState> => {
      const { data, error } = await rpc('national_id_link_state', { p_request_id: requestId });
      if (error) throw new Error(error.message);
      return (data ?? { found: false }) as NationalIdLinkState;
    },
  });
}

/** Sends the code to the holder's number, then checks the code typed back. */
export function useNationalIdLinkOtp() {
  const send = useMutation({
    mutationFn: async (requestId: string) => {
      const { data, error } = await supabase.functions.invoke('national-id-link-otp', {
        body: { action: 'send', request_id: requestId },
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; error?: string };
      if (!res.success) throw new Error(res.error ?? 'Could not send the code.');
      return true;
    },
  });

  const qc = useQueryClient();
  const verify = useMutation({
    mutationFn: async ({ requestId, code }: { requestId: string; code: string }) => {
      const { data, error } = await supabase.functions.invoke('national-id-link-otp', {
        body: { action: 'verify', request_id: requestId, code },
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; error?: string };
      if (!res.success) throw new Error(res.error ?? 'That code is not right.');
      return true;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['national-id-link-state', vars.requestId] });
    },
  });

  return { send, verify };
}

/** Requests waiting for THIS account, because it holds the National ID. */
export function useNationalIdLinkRequestsForHolder() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['national-id-link-holder', user?.id],
    enabled: !!user?.id,
    refetchInterval: LINK_POLL_INTERVAL_MS,
    queryFn: async (): Promise<HolderLinkRequest[]> => {
      const { data, error } = await rpc('national_id_link_holder_requests');
      if (error) throw new Error(error.message);
      return Array.isArray(data) ? data as HolderLinkRequest[] : [];
    },
  });
}

/** The accounts already confirmed under this account's National ID. */
export function useMyNationalIdGroup() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['national-id-link-group', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('national_id_link_requests')
        .select('id, nin, status, staff_decided_at, created_at')
        .eq('holder_id', user!.id)
        .eq('status', 'active')
        .order('staff_decided_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });
}

/** The holder's Yes or No. */
export function useNationalIdLinkOwnerDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => {
      const { data, error } = await rpc('national_id_link_owner_decision', {
        p_request_id: id, p_approve: approve, p_reason: note ?? null,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message ?? 'Could not record that answer.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-link-holder'] });
      qc.invalidateQueries({ queryKey: ['national-id-link-group'] });
    },
  });
}

/** Requests the holder has approved, waiting for staff to confirm the details. */
export function useNationalIdLinkStaffQueue(enabled = true) {
  return useQuery({
    queryKey: ['national-id-link-staff-queue'],
    enabled,
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('national_id_link_requests')
        .select('id, nin, requester_id, holder_id, owner_confirmed_at, code_verified_at, created_at, expires_at')
        .eq('status', 'owner_approved')
        .order('owner_confirmed_at', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

export function useNationalIdLinkStaffConfirm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, approve, reason }: { id: string; approve: boolean; reason: string }) => {
      const { data, error } = await rpc('national_id_link_staff_confirm', {
        p_request_id: id, p_approve: approve, p_reason: reason,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message ?? 'Could not confirm that request.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['national-id-link-staff-queue'] });
    },
  });
}
