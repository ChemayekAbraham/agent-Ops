import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import type { AppRole } from '@/hooks/auth/types';

interface RoleAccessRequest {
  id: string;
  requested_role: string;
  status: string;
  reason: string | null;
  rejection_reason: string | null;
  created_at: string;
}

export function useRoleAccessRequests(userId: string | undefined) {
  const [requests, setRequests] = useState<RoleAccessRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchRequests = useCallback(async () => {
    if (!userId) return;
    const { data } = await supabase
      .from('role_access_requests')
      .select('id, requested_role, status, reason, rejection_reason, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    setRequests((data as RoleAccessRequest[]) || []);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const requestRole = useCallback(async (role: AppRole, reason?: string) => {
    if (!userId) return { error: new Error('Not authenticated') };

    const { error } = await supabase
      .from('role_access_requests')
      .insert({
        user_id: userId,
        requested_role: role,
        status: 'pending',
        reason: reason || `Requesting access to ${role} dashboard`,
      } as any);

    if (!error) {
      await fetchRequests();
    }
    return { error: error as Error | null };
  }, [userId, fetchRequests]);

  const getPendingRequest = useCallback((role: AppRole) => {
    return requests.find(r => r.requested_role === role && r.status === 'pending');
  }, [requests]);

  const hasApplied = useCallback((role: AppRole) => {
    return requests.some(r => r.requested_role === role && r.status === 'pending');
  }, [requests]);

  return { requests, loading, requestRole, getPendingRequest, hasApplied, refetch: fetchRequests };
}
