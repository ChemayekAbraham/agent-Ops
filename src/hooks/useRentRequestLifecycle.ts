import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/**
 * Read-only lifecycle history for a single rent request.
 *
 * Sources (all existing, nothing fabricated):
 *  - rent_requests own stage timestamps (passed in by the caller)
 *  - audit_logs rows where table_name = 'rent_requests' and record_id = the id
 *  - service_center_request_events (vetting stage transitions)
 *
 * No writes. No approvals. Purely a timeline reader.
 */

export interface LifecycleEvent {
  id: string;
  at: string;
  label: string;
  actor: string;
  detail?: string | null;
  source: 'timestamp' | 'audit' | 'service_centre';
}

const ACTION_LABELS: Record<string, string> = {
  rent_request_created: 'Request created',
  rent_request_returned_for_correction: 'Returned for correction',
  rent_request_resubmitted_by_agent: 'Resubmitted by agent',
  rent_request_deleted_by_agent: 'Withdrawn by agent',
  rent_request_force_approved: 'Force approved',
  inline_edit_rent_request: 'Record edited',
  tenant_ops_rent_request_correction: 'Tenant Ops correction',
  tenant_ops_outstanding_correction: 'Outstanding corrected',
  tenant_ops_rent_correction: 'Rent corrected',
  tenant_ops_repaid_correction: 'Repaid corrected',
  'ops.record_payment_edit': 'Payment edit recorded',
  'agent.respond_payment_edit': 'Agent responded to payment edit',
  rent_disbursement: 'Disbursed to landlord',
  rent_float_funding: 'Float funding posted',
  repayment_guard_reconciliation: 'Repayment reconciled',
};

const humanise = (s: string) =>
  s.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function useRentRequestLifecycle(requestId: string | null) {
  return useQuery<LifecycleEvent[]>({
    queryKey: ['rent-request-lifecycle', requestId],
    enabled: !!requestId,
    staleTime: 60000,
    queryFn: async () => {
      if (!requestId) return [];

      const [{ data: audits }, { data: scEvents }] = await Promise.all([
        supabase
          .from('audit_logs')
          .select('id, action_type, user_id, metadata, created_at')
          .eq('table_name', 'rent_requests')
          .eq('record_id', requestId)
          .order('created_at', { ascending: true })
          .limit(200),
        supabase
          .from('service_center_request_events')
          .select('id, from_status, to_status, actor_id, reason, note, created_at')
          .eq('request_id', requestId)
          .order('created_at', { ascending: true })
          .limit(100),
      ]);

      const actorIds = [
        ...new Set(
          [
            ...(audits ?? []).map((a: any) => a.user_id),
            ...(scEvents ?? []).map((e: any) => e.actor_id),
          ].filter(Boolean),
        ),
      ] as string[];

      let actorMap = new Map<string, string>();
      if (actorIds.length) {
        const { data: people } = await supabase
          .from('profiles')
          .select('id, full_name, email')
          .in('id', actorIds);
        actorMap = new Map((people ?? []).map((p: any) => [p.id, p.full_name || p.email || 'User']));
      }

      const events: LifecycleEvent[] = [];

      (audits ?? []).forEach((a: any) => {
        const meta = a.metadata || {};
        const detail =
          meta.reason || meta.note || meta.rejection_reason || meta.correction_reason || null;
        events.push({
          id: `audit-${a.id}`,
          at: a.created_at,
          label: ACTION_LABELS[a.action_type] || humanise(a.action_type),
          actor: a.user_id ? actorMap.get(a.user_id) || 'User' : 'System',
          detail: typeof detail === 'string' ? detail : null,
          source: 'audit',
        });
      });

      (scEvents ?? []).forEach((e: any) => {
        events.push({
          id: `sc-${e.id}`,
          at: e.created_at,
          label: `Service centre: ${humanise(e.from_status || 'unknown')} → ${humanise(e.to_status || 'unknown')}`,
          actor: e.actor_id ? actorMap.get(e.actor_id) || 'User' : 'System',
          detail: e.reason || e.note || null,
          source: 'service_centre',
        });
      });

      return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    },
  });
}
