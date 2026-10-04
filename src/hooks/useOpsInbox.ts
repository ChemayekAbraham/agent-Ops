import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';

export type OpsInboxBucket = 'critical' | 'at_risk' | 'watch' | 'new' | 'snoozed';

export interface OpsInboxRow {
  tenant_id: string;
  full_name: string | null;
  phone: string | null;
  city: string | null;
  severity: OpsInboxBucket;
  reason: string;
  days_no_progress: number | null;
  outstanding_ugx: number;
  trust_score: number;
  trust_tier: string | null;
  last_visit_at: string | null;
  snoozed_until: string | null;
}

export function useOpsInbox(bucket: OpsInboxBucket, opsUserId?: string | null) {
  const q = useQuery({
    queryKey: ['ops-inbox', bucket],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ops_tenant_inbox', {
        p_bucket: bucket,
        p_limit: 100,
      });
      if (error) throw error;
      return (data ?? []) as OpsInboxRow[];
    },
    staleTime: 30_000,
  });

  // Single lean realtime channel — only listens to bucket-change events,
  // never to profiles/rent_requests directly.
  useEffect(() => {
    if (!opsUserId) return;
    const channel = supabase
      .channel(`ops:inbox:${opsUserId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ops_inbox_events' },
        () => q.refetch(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [opsUserId, q]);

  return q;
}

export async function snoozeInboxRow(tenantId: string, hours = 24) {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return;
  const snoozedUntil = new Date(Date.now() + hours * 3_600_000).toISOString();
  await supabase
    .from('ops_inbox_state')
    .upsert(
      { ops_user_id: uid, tenant_id: tenantId, snoozed_until: snoozedUntil, updated_at: new Date().toISOString() },
      { onConflict: 'ops_user_id,tenant_id' },
    );
}

export async function escalateInboxRow(tenantId: string, note?: string) {
  const { data: u } = await supabase.auth.getUser();
  const uid = u.user?.id;
  if (!uid) return;
  await supabase
    .from('ops_inbox_state')
    .upsert(
      { ops_user_id: uid, tenant_id: tenantId, escalated_at: new Date().toISOString(), notes: note ?? null, updated_at: new Date().toISOString() },
      { onConflict: 'ops_user_id,tenant_id' },
    );
}
