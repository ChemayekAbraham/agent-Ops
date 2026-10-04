/**
 * ProxyOnboardingAuditPanel — read-only audit trail of proxy agent onboarding
 * and vetting decisions (who acted, what changed, when).
 *
 * Data comes from one authorized RPC (partner_ops_proxy_onboarding_audit) that
 * reads audit_logs for the proxy_agent_identity table.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ChevronDown, History, Loader2, RefreshCw, Search } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type AuditRow = {
  id: string;
  action_type: string;
  record_id: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_phone: string | null;
  subject_name: string | null;
  subject_phone: string | null;
};

const ACTION_LABEL: Record<string, string> = {
  proxy_agent_onboarded: 'Onboarded directly',
  proxy_agent_approved: 'Approved',
  proxy_agent_rejected: 'Rejected',
  proxy_agent_suspended: 'Rights withdrawn',
};

const ACTION_TONE: Record<string, string> = {
  proxy_agent_onboarded: 'border-primary/30 bg-primary/10 text-primary',
  proxy_agent_approved: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  proxy_agent_rejected: 'border-destructive/30 bg-destructive/10 text-destructive',
  proxy_agent_suspended: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
};

const FIELD_LABEL: Record<string, string> = {
  status: 'Status',
  full_name: 'Full name',
  phone: 'Phone',
  nin: 'National ID',
  review_notes: 'Review note',
};

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  return String(value);
}

function diffFields(row: AuditRow) {
  const before = row.old_values ?? {};
  const after = row.new_values ?? {};
  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)]));
  return keys
    .filter((k) => display(before[k]) !== display(after[k]))
    .map((k) => ({ key: k, label: FIELD_LABEL[k] ?? k, from: display(before[k]), to: display(after[k]) }));
}

export function ProxyOnboardingAuditPanel() {
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['proxy-onboarding-audit'],
    queryFn: async (): Promise<AuditRow[]> => {
      const { data, error } = await supabase.rpc('partner_ops_proxy_onboarding_audit', { p_limit: 100 });
      if (error) throw error;
      return (data ?? []) as unknown as AuditRow[];
    },
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const all = query.data ?? [];
    const t = term.trim().toLowerCase();
    if (!t) return all;
    return all.filter((r) =>
      [r.actor_name, r.subject_name, r.subject_phone, r.reason, ACTION_LABEL[r.action_type] ?? r.action_type]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(t)),
    );
  }, [query.data, term]);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <History className="h-4 w-4 text-primary" />
              Onboarding audit trail
            </h3>
            <p className="text-[11px] text-muted-foreground">
              Who onboarded or vetted each proxy agent, what data changed, and when.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Search agent or staff"
                className="h-8 w-[200px] pl-8 text-xs"
              />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => qc.invalidateQueries({ queryKey: ['proxy-onboarding-audit'] })}
            >
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', query.isFetching && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>

        {query.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 rounded-lg" />
            ))}
          </div>
        ) : query.isError ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            Audit trail unavailable for your role.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">No onboarding activity recorded yet.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => {
              const changes = diffFields(r);
              const open = expanded === r.id;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : r.id)}
                    className="grid w-full grid-cols-1 items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/40 md:grid-cols-12"
                  >
                    <div className="min-w-0 md:col-span-4">
                      <p className="truncate text-xs font-semibold">{r.subject_name || 'Unknown agent'}</p>
                      <p className="truncate text-[11px] text-muted-foreground">{r.subject_phone || '—'}</p>
                    </div>
                    <div className="md:col-span-3">
                      <Badge
                        variant="outline"
                        className={cn('text-[9px]', ACTION_TONE[r.action_type] ?? 'text-muted-foreground')}
                      >
                        {ACTION_LABEL[r.action_type] ?? r.action_type}
                      </Badge>
                    </div>
                    <div className="min-w-0 md:col-span-3">
                      <p className="truncate text-[11px] font-medium">{r.actor_name || 'System'}</p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {changes.length > 0 ? `${changes.length} field(s) changed` : 'No field snapshot'}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-2 md:col-span-2 md:justify-end">
                      <p className="text-[11px] tabular-nums text-muted-foreground md:text-right">
                        {format(new Date(r.created_at), 'dd MMM yyyy HH:mm')}
                      </p>
                      <ChevronDown
                        className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')}
                      />
                    </div>
                  </button>

                  {open && (
                    <div className="space-y-3 border-t bg-muted/20 px-4 py-3">
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Reason</p>
                        <p className="text-xs">{r.reason || '—'}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Data changes
                        </p>
                        {changes.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            No before/after snapshot was recorded for this action.
                          </p>
                        ) : (
                          <ul className="mt-1 space-y-1">
                            {changes.map((c) => (
                              <li key={c.key} className="flex flex-wrap items-baseline gap-1.5 text-xs">
                                <span className="font-medium">{c.label}:</span>
                                <span className="text-muted-foreground line-through">{c.from}</span>
                                <span className="text-muted-foreground">→</span>
                                <span className="font-semibold">{c.to}</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Recorded {format(new Date(r.created_at), 'dd MMM yyyy HH:mm:ss')} · Reference {r.id.slice(0, 8)}
                      </p>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {query.isFetching && !query.isLoading && (
          <div className="flex items-center justify-center gap-1.5 border-t px-4 py-2 text-[11px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Updating
          </div>
        )}
      </CardContent>
    </Card>
  );
}
