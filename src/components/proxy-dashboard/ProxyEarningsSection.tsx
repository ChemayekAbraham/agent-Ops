import { Wallet } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { ProxyPerformanceDashboard } from '@/hooks/useProxyPerformanceDashboard';
import { earningKind, useProxyEarningsHistory, type EarningKind } from '@/hooks/useProxyEarningsHistory';
import { EmptyState, ListSkeleton, SectionError, SectionTitle, StatusPill, shortDate, ugx } from './ProxyDashboardParts';

const KIND_LABEL: Record<EarningKind, string> = {
  note: 'Promissory Note', initial: 'Initial Support', topup: 'Partner Top-up', other: 'Commission',
};

export function ProxyEarningsSection({ userId, summary }: { userId?: string; summary?: ProxyPerformanceDashboard }) {
  const hist = useProxyEarningsHistory(userId);
  const c = summary?.commission;
  const total = c?.earned ?? 0;
  const parts = c ? [
    { k: 'Promissory Notes', sub: `${ugx(c.note_rate)} per note brought in`, v: c.notes },
    { k: `Initial Support · ${c.initial_support_pct}%`, sub: "of a partner's first money in", v: c.initial_support },
    { k: `Top-ups · ${c.top_up_pct}%`, sub: 'of every top-up', v: c.top_ups },
  ] : [];

  return (
    <div className="space-y-3">
      <SectionTitle title="Earnings" />
      {!c ? <Skeleton className="h-56 rounded-xl" /> : (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="border-success/20 bg-success/5 p-4 shadow-none lg:col-span-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Total earned</p>
            <p className="mt-1 text-3xl font-bold tabular-nums text-success">{ugx(total)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Paid into your wallet. Today: {ugx(c.today)}</p>
            <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-2.5">
              <p className="text-xs text-muted-foreground">Pending</p>
              <p className="text-lg font-bold tabular-nums text-warning">{ugx(c.pending)}</p>
              <p className="text-[11px] text-muted-foreground">{c.pending_notes} note{c.pending_notes === 1 ? '' : 's'} not yet brought in</p>
            </div>
          </Card>
          <Card className="p-4 shadow-none lg:col-span-2">
            <p className="text-sm font-semibold">Breakdown</p>
            <div className="mt-3 space-y-3">
              {parts.map((p) => {
                const pct = total > 0 ? Math.round((p.v / total) * 100) : 0;
                return (
                  <div key={p.k}>
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="min-w-0"><p className="truncate text-sm font-medium">{p.k}</p><p className="text-[11px] text-muted-foreground">{p.sub}</p></div>
                      <p className="shrink-0 text-sm font-bold tabular-nums">{ugx(p.v)}</p>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} /></div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      <h2 className="pt-1 text-base font-bold">Recent Earnings</h2>
      {hist.isError ? <SectionError label="your earnings" onRetry={() => hist.refetch()} />
        : hist.isLoading ? <ListSkeleton rows={3} />
        : !hist.data?.length ? <EmptyState icon={Wallet} title="Your commission earnings will appear here after qualifying activity." />
        : (
          <Card className="divide-y p-0 shadow-none">
            {hist.data.map((r) => (
              <div key={r.id} className="flex items-start justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold">{KIND_LABEL[earningKind(r)]}</p>
                  {r.description && <p className="line-clamp-2 text-xs text-muted-foreground">{r.description}</p>}
                  <p className="text-[11px] text-muted-foreground">{shortDate(r.transaction_date)}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <p className="text-sm font-bold tabular-nums text-success">+ {ugx(r.amount)}</p>
                  <StatusPill tone="success">Earned</StatusPill>
                </div>
              </div>
            ))}
          </Card>
        )}
    </div>
  );
}
