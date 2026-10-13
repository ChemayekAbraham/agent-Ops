import { useMemo, useState } from 'react';
import { ChevronDown, FileDown, Loader2, Package, Search } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import { useServiceCenterAdvances } from '@/hooks/useServiceCenterAdvances';
import { cn } from '@/lib/utils';

const day = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'Africa/Kampala' }) : '—';

export function ServiceCenterAdvancesTracker() {
  const { data, isLoading, error } = useServiceCenterAdvances();
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const plans = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = data?.plans ?? [];
    return s ? all.filter((p) => [p.holder_name, p.holder_phone, p.item_name].some((v) => (v ?? '').toLowerCase().includes(s))) : all;
  }, [data, q]);

  const exportPdf = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const { generateServiceCenterAdvancesPdf } = await import('@/lib/serviceCenterAdvancesPdf');
      const blob = await generateServiceCenterAdvancesPdf(data);
      const name = `Welile_Service_Centre_Advances_${new Date().toISOString().slice(0, 10)}.pdf`;
      const file = new File([blob], name, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Service Centre advances' }).catch(() => {});
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
    } catch (e) {
      toast({ title: 'Could not create the report', description: (e as Error).message, variant: 'destructive' });
    } finally { setExporting(false); }
  };

  if (isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>;
  if (error) return <Card><CardContent className="p-4 text-sm text-destructive">Could not load advances: {(error as Error).message}</CardContent></Card>;
  const t = data!.totals;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-xs text-muted-foreground">Active advances</p>
              <p className="text-2xl font-bold text-foreground">{data!.plans.length}</p>
            </div>
            <Button size="sm" variant="outline" onClick={exportPdf} disabled={exporting || !data!.plans.length} className="gap-1.5">
              {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} PDF report
            </Button>
          </div>
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>Repaid {formatUGX(t.repaid)} of {formatUGX(t.original)}</span><span className="font-semibold text-foreground">{t.pct}%</span>
            </div>
            <Progress value={t.pct} className="h-2.5" />
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['Still owed', t.outstanding], ['Expected daily', t.daily], ['Repaid last 7 days', t.paid7d], ['Behind schedule', t.due],
            ].map(([l, v]) => (
              <div key={l as string} className="rounded-lg border bg-muted/30 p-2">
                <p className="text-[11px] text-muted-foreground">{l}</p>
                <p className="text-sm font-semibold text-foreground">{formatUGX(v as number)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {data!.plans.length > 0 && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, phone or item" className="pl-9" />
        </div>
      )}

      {plans.length === 0 ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          {data!.plans.length ? 'No advances match your search.' : 'No active advances in your Service Centre.'}
        </CardContent></Card>
      ) : plans.map((p) => {
        const isOpen = open === p.id;
        return (
          <Card key={p.id} className="overflow-hidden">
            <button type="button" className="w-full text-left" onClick={() => setOpen(isOpen ? null : p.id)} aria-expanded={isOpen}>
              <CardContent className="space-y-2 p-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10">
                    <Package className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-semibold text-foreground">{p.holder_name || 'Unknown'}</span>
                      {p.is_self && <Badge variant="secondary" className="text-[10px]">You</Badge>}
                      {p.on_hold && <Badge variant="outline" className="text-[10px]">On hold</Badge>}
                      {p.due_balance > 0 && <Badge variant="destructive" className="text-[10px]">Behind</Badge>}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{p.item_name} · {formatUGX(p.daily)}/day</p>
                  </div>
                  <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
                </div>
                <Progress value={p.pct} className="h-1.5" />
                <div className="flex justify-between text-[11px] text-muted-foreground">
                  <span>Repaid {formatUGX(p.repaid)} ({p.pct}%)</span><span>Owed {formatUGX(p.outstanding)}</span>
                </div>
              </CardContent>
            </button>
            {isOpen && (
              <div className="space-y-2 border-t bg-muted/20 p-3 text-xs">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
                  <span className="text-muted-foreground">Value <b className="text-foreground">{formatUGX(p.original_amount)}</b></span>
                  <span className="text-muted-foreground">Due now <b className="text-foreground">{formatUGX(p.due_balance)}</b></span>
                  <span className="text-muted-foreground">Last 7 days <b className="text-foreground">{formatUGX(p.paid_7d)}</b></span>
                  <span className="text-muted-foreground">Started <b className="text-foreground">{day(p.starts_on)}</b></span>
                  <span className="text-muted-foreground">Ends <b className="text-foreground">{day(p.term_end_on)}</b></span>
                  <span className="text-muted-foreground">Phone <b className="text-foreground">{p.holder_phone || '—'}</b></span>
                </div>
                <p className="pt-1 font-semibold text-foreground">Recent payments</p>
                {p.recent.length === 0 ? <p className="text-muted-foreground">No payments yet.</p> : (
                  <ul className="divide-y rounded-md border bg-card">
                    {p.recent.map((r, i) => (
                      <li key={i} className="flex justify-between gap-2 px-2 py-1.5">
                        <span className="text-muted-foreground">{day(r.at)}</span>
                        <span className="font-medium text-foreground">{formatUGX(r.amount)}</span>
                        <span className="text-muted-foreground">Bal {formatUGX(r.outstanding_after)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
