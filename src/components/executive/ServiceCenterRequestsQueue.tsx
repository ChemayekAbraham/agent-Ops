import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Store, AlertTriangle, RefreshCw } from 'lucide-react';

const STATUSES = ['pending_review', 'more_info_requested', 'approved', 'rejected'] as const;

export function ServiceCenterRequestsQueue() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string>('pending_review');
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['sc-requests', status],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('admin_list_service_center_requests', {
        p_status: status,
        p_limit: 100,
        p_offset: 0,
      });
      if (error) throw error;
      return data as { total: number; rows: any[] };
    },
    staleTime: 30_000,
  });

  const decide = async (id: string, decision: string) => {
    const reason = reasons[id]?.trim() || '';
    if (decision === 'reject' && !reason) { toast.error('A rejection reason is required'); return; }
    setBusy(id);
    try {
      const { error } = await (supabase.rpc as any)('admin_decide_service_center_request', {
        p_request_id: id,
        p_decision: decision,
        p_reason: reason || null,
        p_internal_note: decision === 'note' ? reason : null,
      });
      if (error) throw error;
      toast.success('Decision recorded');
      setReasons((r) => ({ ...r, [id]: '' }));
      qc.invalidateQueries({ queryKey: ['sc-requests'] });
    } catch (e: any) {
      toast.error(e?.message || 'Could not record the decision');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-lg font-semibold mr-auto">
          <Store className="h-4 w-4 text-primary" /> Service Center Requests
        </h2>
        {STATUSES.map((s) => (
          <Button key={s} size="sm" variant={status === s ? 'default' : 'outline'} onClick={() => setStatus(s)}>
            {s.replace(/_/g, ' ')}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => refetch()}><RefreshCw className="h-3.5 w-3.5" /></Button>
      </div>

      {isLoading && <Skeleton className="h-40 w-full" />}
      {isError && <p className="text-sm text-muted-foreground">Could not load service center requests.</p>}
      {!isLoading && data?.rows?.length === 0 && (
        <p className="text-sm text-muted-foreground">No requests in this status.</p>
      )}

      <div className="space-y-3">
        {(data?.rows || []).map((r: any) => {
          const cur = r.current_metrics || {};
          const changed =
            cur.qualifying_sub_agents < r.qualifying_sub_agents_at_submission ||
            cur.main_agent_active_tenants < r.personal_active_tenants_at_submission;
          return (
            <div key={r.id} className="rounded-xl border border-border/60 bg-card p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-foreground">{r.agent_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.agent_phone} · {r.district || r.profile_district || 'No district'} · {r.agent_location || 'No location'}
                  </p>
                </div>
                <span className="text-[11px] rounded-full bg-muted px-2 py-1">{r.status.replace(/_/g, ' ')}</span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <Stat label="Sub-agents (at request)" v={r.qualifying_sub_agents_at_submission} now={cur.qualifying_sub_agents} />
                <Stat label="Personal tenants (at request)" v={r.personal_active_tenants_at_submission} now={cur.main_agent_active_tenants} />
                <Stat label="Network tenants" v={r.network_active_tenants_at_submission} now={cur.network_active_tenants} />
                <div className="rounded-lg border border-border/60 p-2">
                  <p className="text-muted-foreground">Submitted</p>
                  <p className="font-semibold text-foreground">{new Date(r.submitted_at).toLocaleDateString()}</p>
                  <p className="text-muted-foreground">
                    Qualified {r.qualified_at ? new Date(r.qualified_at).toLocaleDateString() : '—'}
                  </p>
                </div>
              </div>

              <div className="text-xs text-muted-foreground space-y-1">
                <p><span className="text-foreground font-medium">Preferred location:</span> {r.preferred_location}</p>
                <p><span className="text-foreground font-medium">Reason:</span> {r.reason}</p>
                {r.supporting_note && <p><span className="text-foreground font-medium">Note:</span> {r.supporting_note}</p>}
                <p>Existing service centres: {r.existing_service_centres ?? 0}</p>
                {r.internal_notes && <p className="whitespace-pre-line">Internal: {r.internal_notes}</p>}
                {r.decision_reason && <p className="text-destructive">Decision reason: {r.decision_reason}</p>}
              </div>

              {(changed || r.profile_is_frozen) && (
                <p className={cn('flex items-center gap-1.5 text-xs rounded-md px-2 py-1.5 bg-warning/10 text-warning')}>
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {r.profile_is_frozen ? 'Agent account is frozen. ' : ''}
                  {changed ? 'Current qualification has changed since submission.' : ''}
                </p>
              )}

              {['pending_review', 'more_info_requested'].includes(r.status) && (
                <div className="space-y-2">
                  <Textarea
                    rows={2}
                    placeholder="Reason / internal note"
                    value={reasons[r.id] || ''}
                    onChange={(e) => setReasons((s) => ({ ...s, [r.id]: e.target.value }))}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" disabled={busy === r.id} onClick={() => decide(r.id, 'approve')}>Approve</Button>
                    <Button size="sm" variant="destructive" disabled={busy === r.id} onClick={() => decide(r.id, 'reject')}>Reject</Button>
                    <Button size="sm" variant="outline" disabled={busy === r.id} onClick={() => decide(r.id, 'more_info')}>Request more info</Button>
                    <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => decide(r.id, 'note')}>Add internal note</Button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Stat({ label, v, now }: { label: string; v: number; now?: number }) {
  return (
    <div className="rounded-lg border border-border/60 p-2">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-semibold text-foreground tabular-nums">{v}</p>
      {now != null && <p className="text-muted-foreground">now {now}</p>}
    </div>
  );
}

export default ServiceCenterRequestsQueue;