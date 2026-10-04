import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { Download, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';

import { MERCHANT_QUEUE_STATUSES } from '@/lib/merchantPayoutQueue';

// Must mirror AgentCashPayoutsTab / AgentDashboard exactly — this dialog exists
// so anyone can independently reproduce the "N unclaimed requests waiting" count.
const CASHOUT_QUEUE_STATUSES = MERCHANT_QUEUE_STATUSES as unknown as string[];
const CLAIM_WINDOW_MINUTES = 15;

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type Row = {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  payout_method: string | null;
  mobile_money_number: string | null;
  bank_account_number: string | null;
  assigned_cashout_agent_id: string | null;
  dispatched_at: string | null;
  created_at: string;
};

export function MerchantPayoutsAuditDialog({ open, onOpenChange }: Props) {
  const cutoffIso = useMemo(
    () => new Date(Date.now() - CLAIM_WINDOW_MINUTES * 60 * 1000).toISOString(),
    // Recompute each time the dialog opens so the filter matches the live card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['merchant-payouts-audit', open, cutoffIso],
    enabled: open,
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select(
          'id, user_id, amount, status, payout_method, mobile_money_number, bank_account_number, assigned_cashout_agent_id, dispatched_at, created_at',
        )
        .in('status', CASHOUT_QUEUE_STATUSES)
        .is('processed_at', null)
        .is('fin_ops_reference', null)
        .or(`assigned_cashout_agent_id.is.null,dispatched_at.lt.${cutoffIso}`)
        .order('created_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const rows = data ?? [];

  // Flag potentially problematic entries.
  const flagged = useMemo(() => {
    // Duplicate = same user + amount + destination number, still open.
    const dupKeyCounts = new Map<string, number>();
    for (const r of rows) {
      const dest = r.mobile_money_number || r.bank_account_number || '';
      const k = `${r.user_id}|${r.amount}|${dest}`;
      dupKeyCounts.set(k, (dupKeyCounts.get(k) || 0) + 1);
    }
    const now = Date.now();
    return rows.map((r) => {
      const dest = r.mobile_money_number || r.bank_account_number || '';
      const k = `${r.user_id}|${r.amount}|${dest}`;
      const ageHrs = (now - new Date(r.created_at).getTime()) / 3600_000;
      const claimExpired =
        r.assigned_cashout_agent_id != null &&
        r.dispatched_at != null &&
        new Date(r.dispatched_at).getTime() < now - CLAIM_WINDOW_MINUTES * 60_000;
      const flags: string[] = [];
      if ((dupKeyCounts.get(k) || 0) > 1) flags.push('duplicate');
      if (Number(r.amount) <= 0) flags.push('zero_amount');
      if (ageHrs > 24) flags.push('stale_24h');
      if (claimExpired) flags.push('expired_claim');
      if (!dest) flags.push('no_destination');
      return { row: r, flags, ageHrs };
    });
  }, [rows]);

  const stats = useMemo(() => {
    const flags = { duplicate: 0, zero_amount: 0, stale_24h: 0, expired_claim: 0, no_destination: 0 } as Record<string, number>;
    for (const f of flagged) for (const t of f.flags) flags[t] = (flags[t] || 0) + 1;
    const byStatus = new Map<string, number>();
    for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1);
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const suspicious = flagged.filter((f) => f.flags.length > 0).length;
    return { flags, byStatus: [...byStatus.entries()], total, suspicious };
  }, [flagged, rows]);

  const dateRange = useMemo(() => {
    if (rows.length === 0) return null;
    const ts = rows.map((r) => new Date(r.created_at).getTime());
    return { min: new Date(Math.min(...ts)), max: new Date(Math.max(...ts)) };
  }, [rows]);

  const exportCsv = () => {
    const header = [
      'withdrawal_request_id',
      'user_id',
      'amount_ugx',
      'status',
      'payout_method',
      'destination',
      'created_at',
      'assigned_cashout_agent_id',
      'dispatched_at',
      'flags',
    ];
    const lines = [header.join(',')];
    for (const { row, flags } of flagged) {
      const dest = row.mobile_money_number || row.bank_account_number || '';
      lines.push(
        [
          row.id,
          row.user_id,
          row.amount,
          row.status,
          row.payout_method ?? '',
          dest,
          row.created_at,
          row.assigned_cashout_agent_id ?? '',
          row.dispatched_at ?? '',
          flags.join('|'),
        ]
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(','),
      );
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `merchant-payouts-audit-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            Merchant Payouts — Audit
          </DialogTitle>
          <DialogDescription>
            Exact filters and IDs behind the "unclaimed requests waiting" count.
          </DialogDescription>
        </DialogHeader>

        {/* Filters used */}
        <section className="rounded-xl border border-border/60 bg-muted/40 p-3 text-xs">
          <p className="font-semibold text-foreground">Filters applied</p>
          <ul className="mt-1.5 space-y-1 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Table:</span> withdrawal_requests
            </li>
            <li>
              <span className="font-medium text-foreground">Status ∈</span>{' '}
              [pending, requested, manager_approved, cfo_approved, fin_ops_approved]
            </li>
            <li>
              <span className="font-medium text-foreground">Claim state:</span>{' '}
              assigned_cashout_agent_id IS NULL <em>OR</em> dispatched_at &lt; now − {CLAIM_WINDOW_MINUTES} min
            </li>
            <li>
              <span className="font-medium text-foreground">Date range (from data):</span>{' '}
              {dateRange
                ? `${format(dateRange.min, 'yyyy-MM-dd HH:mm')} → ${format(dateRange.max, 'yyyy-MM-dd HH:mm')}`
                : '—'}
            </li>
            <li>
              <span className="font-medium text-foreground">Snapshot taken:</span>{' '}
              {format(new Date(), 'yyyy-MM-dd HH:mm:ss')}
            </li>
          </ul>
        </section>

        {/* Summary */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryTile label="Included" value={String(rows.length)} />
          <SummaryTile label="Total UGX" value={formatUGX(stats.total)} />
          <SummaryTile label="Flagged" value={String(stats.suspicious)} tone={stats.suspicious > 0 ? 'warn' : 'ok'} />
          <SummaryTile
            label="Statuses"
            value={stats.byStatus.map(([s, c]) => `${s}:${c}`).join(' · ') || '—'}
            small
          />
        </section>

        {/* Flag breakdown */}
        <section className="flex flex-wrap gap-2 text-xs">
          {Object.entries(stats.flags).map(([k, v]) => (
            <Badge key={k} variant={v > 0 ? 'destructive' : 'secondary'}>
              {k}: {v}
            </Badge>
          ))}
        </section>

        {/* Actions */}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Anyone can rerun the same query in SQL to reproduce this count.
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              {isFetching ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Refresh
            </Button>
            <Button size="sm" onClick={exportCsv} disabled={rows.length === 0}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </div>

        {/* Row list */}
        <section className="rounded-xl border border-border/60">
          <div className="max-h-[45vh] overflow-y-auto divide-y divide-border/60">
            {isLoading ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" /> Loading…
              </div>
            ) : isError ? (
              <div className="p-6 text-center text-sm text-destructive">
                Failed to load the audit set.
              </div>
            ) : rows.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No pending merchant payouts right now.
              </div>
            ) : (
              flagged.map(({ row, flags }) => (
                <div key={row.id} className="flex items-start justify-between gap-3 p-3 text-xs">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-[11px] text-foreground">{row.id}</p>
                    <p className="mt-0.5 text-muted-foreground">
                      {formatUGX(Number(row.amount))} · {row.status} · {row.payout_method || '—'}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      dest {row.mobile_money_number || row.bank_account_number || '—'} ·{' '}
                      {format(new Date(row.created_at), 'yyyy-MM-dd HH:mm')}
                    </p>
                    {flags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {flags.map((f) => (
                          <span
                            key={f}
                            className="inline-flex items-center gap-0.5 rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold text-destructive"
                          >
                            <AlertTriangle className="h-2.5 w-2.5" />
                            {f}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </DialogContent>
    </Dialog>
  );
}

function SummaryTile({
  label,
  value,
  tone = 'default',
  small = false,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'ok' | 'warn';
  small?: boolean;
}) {
  const toneCls =
    tone === 'warn'
      ? 'text-destructive'
      : tone === 'ok'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-foreground';
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 font-bold ${small ? 'text-[11px]' : 'text-sm'} ${toneCls}`}>{value}</p>
    </div>
  );
}
