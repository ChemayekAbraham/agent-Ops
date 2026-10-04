import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { AlertTriangle, Calculator, CheckCircle2, Clock, FileText, Receipt } from 'lucide-react';
import {
  useProxyPvActivityDetail,
  type ProxyPvActivityItem,
  type ProxyPvActivityKind,
} from '@/hooks/useProxyAgentPerformance';

const money = (v: unknown) => formatDynamic(v);

const KIND_LABEL: Record<ProxyPvActivityKind, string> = {
  commitments: 'Verified commitments',
  investment: 'New partner investment',
  topups: 'Partner top-ups',
};

function dayLabel(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function timeLabel(iso?: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TransactionRow({ item }: { item: ProxyPvActivityItem }) {
  return (
    <div className="space-y-1.5 rounded-xl border border-border/60 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-bold">{item.party}</p>
          <p className="truncate text-[9px] font-mono uppercase text-muted-foreground">
            {item.reference}
            {item.contact ? ` · ${item.contact}` : ''}
          </p>
        </div>
        <span
          className={cn(
            'shrink-0 text-[11px] font-black tabular-nums',
            item.counted ? 'text-success' : 'text-muted-foreground',
          )}
        >
          {item.counted ? `+${money(item.pv)} PV` : '0 PV'}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            'gap-1 text-[9px] font-bold',
            item.counted
              ? 'border-success/30 bg-success/10 text-success'
              : 'border-warning/30 bg-warning/10 text-warning',
          )}
        >
          {item.counted ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          {item.status}
        </Badge>
        <span className="text-[9px] text-muted-foreground break-words">{item.verification_label}</span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        <div className="flex justify-between gap-2">
          <dt className="text-muted-foreground">Amount</dt>
          <dd className="font-semibold tabular-nums">{money(item.amount)}</dd>
        </div>
        {item.rate != null && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Rate</dt>
            <dd className="font-semibold tabular-nums">{(item.rate * 100).toFixed(2)}%</dd>
          </div>
        )}
        {item.recorded_at && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Recorded</dt>
            <dd className="font-semibold">{timeLabel(item.recorded_at)}</dd>
          </div>
        )}
        {item.verified_at && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Verified</dt>
            <dd className="font-semibold">{timeLabel(item.verified_at)}</dd>
          </div>
        )}
        {item.verified_by && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Verified by</dt>
            <dd className="truncate font-semibold">{item.verified_by}</dd>
          </div>
        )}
        {item.contribution_type && (
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">Type</dt>
            <dd className="truncate font-semibold">{item.contribution_type}</dd>
          </div>
        )}
      </dl>

      <p className="rounded-lg bg-muted/50 px-2 py-1 text-[9px] font-mono text-muted-foreground break-words">
        {item.pv_formula}
      </p>
    </div>
  );
}

/** Drilldown behind a single scored activity: transactions, verification, scoring inputs. */
export function ProxyActivityDrilldownDialog({
  open,
  onOpenChange,
  agentId,
  day,
  kind,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId?: string | null;
  day: string | null;
  kind: ProxyPvActivityKind | null;
}) {
  const q = useProxyPvActivityDetail({ agentId, day, kind, enabled: open });
  const d = q.data;
  const s = d?.scoring;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader className="text-left">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Receipt className="h-4 w-4 text-primary" />
            {kind ? KIND_LABEL[kind] : 'Activity'}
          </DialogTitle>
          <DialogDescription className="text-xs">{dayLabel(day)}</DialogDescription>
        </DialogHeader>

        {q.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
            <Skeleton className="h-20 rounded-xl" />
          </div>
        ) : q.error ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            <p className="text-sm font-bold">Couldn't load this activity</p>
            <p className="max-w-sm text-xs text-muted-foreground break-words">{(q.error as Error).message}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Scoring calculation inputs */}
            {s && (
              <Card className="border-primary/30">
                <CardContent className="space-y-2 p-3">
                  <div className="flex items-center gap-1.5">
                    <Calculator className="h-3.5 w-3.5 text-primary" />
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      Scoring calculation
                    </p>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
                    {s.commitment_pv_rate != null && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">PV per commitment</dt>
                        <dd className="font-bold tabular-nums">{money(s.commitment_pv_rate)}</dd>
                      </div>
                    )}
                    {s.percentage_rate != null && (
                      <div className="flex justify-between gap-2">
                        <dt className="text-muted-foreground">Commission rate</dt>
                        <dd className="font-bold tabular-nums">{(s.percentage_rate * 100).toFixed(2)}%</dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Counted items</dt>
                      <dd className="font-bold tabular-nums">{s.counted_items}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Pending items</dt>
                      <dd className="font-bold tabular-nums">{s.pending_items}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">Counted basis</dt>
                      <dd className="font-bold tabular-nums">{money(s.counted_basis)}</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">PV earned</dt>
                      <dd className="font-black tabular-nums text-success">{money(s.counted_pv)}</dd>
                    </div>
                  </dl>
                  <Separator />
                  <p className="rounded-lg bg-muted/50 px-2 py-1.5 text-[10px] font-mono break-words">{s.formula}</p>
                  <p className="text-[9px] text-muted-foreground break-words">{s.gate}</p>
                  {s.pending_pv > 0 && (
                    <p className="text-[10px] font-semibold text-warning break-words">
                      {money(s.pending_pv)} PV is waiting on verification and is not in your score yet.
                    </p>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Underlying transactions */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Underlying transactions
                </p>
                <Badge variant="outline" className="ml-auto text-[9px]">
                  {d?.items.length ?? 0}
                </Badge>
              </div>
              {(d?.items.length ?? 0) === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-3 text-[10px] text-muted-foreground">
                  No transactions recorded on this date for this action.
                </p>
              ) : (
                d!.items.map((it) => <TransactionRow key={it.id} item={it} />)
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
