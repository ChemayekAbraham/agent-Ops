import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Banknote, Clock, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { useServiceCentres, SERVICE_CENTRE_BONUS } from '@/hooks/useServiceCentres';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

/**
 * Read-only payout ledger for Agent Ops. The actual UGX 25,000 disbursement
 * stays with the CFO (Service Centre Payout Approval) — this view only tracks
 * what Agent Ops has verified and what the CFO has settled.
 */
export function ServiceCentrePayouts() {
  const { data: centres, isLoading } = useServiceCentres();

  const { awaiting, settled, committed, paidOut } = useMemo(() => {
    const rows = centres || [];
    const awaiting = rows.filter((r) => r.status === 'verified' || r.status === 'approved');
    const settled = rows.filter((r) => r.status === 'paid');
    return {
      awaiting, settled,
      committed: awaiting.length * SERVICE_CENTRE_BONUS,
      paidOut: settled.length * SERVICE_CENTRE_BONUS,
    };
  }, [centres]);

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock className="h-3.5 w-3.5" />Committed, not yet paid</p>
          <p className="text-2xl font-bold mt-1">{ugx(committed)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{awaiting.length} verified centre{awaiting.length !== 1 ? 's' : ''} queued with the CFO</p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><Banknote className="h-3.5 w-3.5" />Paid to date</p>
          <p className="text-2xl font-bold mt-1 text-emerald-600">{ugx(paidOut)}</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">{settled.length} centre bonus payment{settled.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <PayoutList title="Awaiting CFO payout" rows={awaiting} dateKey="verified_at" empty="Nothing verified is waiting on the CFO." />
      <PayoutList title="Settled payouts" rows={settled} dateKey="approved_at" empty="No service centre bonuses have been paid yet." />
    </div>
  );
}

function PayoutList({ title, rows, dateKey, empty }: { title: string; rows: any[]; dateKey: 'verified_at' | 'approved_at'; empty: string }) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          {title}
          <span className="ml-auto text-xs font-normal text-muted-foreground">{rows.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">{empty}</p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{r.agent_name}</p>
                  <p className="text-xs text-muted-foreground truncate">{r.agent_phone} · {r[dateKey] ? format(new Date(r[dateKey]), 'dd MMM yyyy') : '—'}</p>
                </div>
                <Badge variant="outline" className="shrink-0 text-xs">{ugx(SERVICE_CENTRE_BONUS)}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
