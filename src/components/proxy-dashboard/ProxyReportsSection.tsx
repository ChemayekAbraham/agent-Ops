import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useProxyPerformanceDashboard, type ProxyRange } from '@/hooks/useProxyPerformanceDashboard';
import { useProxyEarningsHistory } from '@/hooks/useProxyEarningsHistory';
import { SectionError, SectionTitle, ugx } from './ProxyDashboardParts';

const LABEL: Record<ProxyRange, string> = { today: 'Today', yesterday: 'Yesterday', '7d': '7 Days', '30d': '30 Days', month: 'This Month' };

export function ProxyReportsSection({ userId }: { userId?: string }) {
  const [range, setRange] = useState<ProxyRange>('7d');
  const q = useProxyPerformanceDashboard(userId, range);
  const d = q.data;
  const from = d?.series[0]?.date;
  const to = d?.series[d.series.length - 1]?.date;
  const earn = useProxyEarningsHistory(userId, from ? `${from}T00:00:00` : undefined);

  const t = useMemo(() => {
    if (!d) return null;
    const created = d.series.reduce((a, s) => a + s.pending, 0);
    const broughtIn = d.series.reduce((a, s) => a + s.brought_in, 0);
    const commission = (earn.data ?? []).filter((r) => !to || r.transaction_date.slice(0, 10) <= to).reduce((a, r) => a + Number(r.amount), 0);
    return { created, broughtIn, conversion: created > 0 ? Math.round((broughtIn / created) * 100) : null, commission };
  }, [d, earn.data, to]);

  const exportCsv = () => {
    if (!d) return;
    const rows = [['Date', 'Notes created', 'Notes brought in'], ...d.series.map((s) => [s.date, String(s.pending), String(s.brought_in)])];
    const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `proxy-performance-${range}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="space-y-3">
      <SectionTitle title="Reports" action={
        <Select value={range} onValueChange={(v) => setRange(v as ProxyRange)}>
          <SelectTrigger className="h-8 w-[130px] text-xs" aria-label="Report period"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(LABEL) as ProxyRange[]).map((k) => <SelectItem key={k} value={k}>{LABEL[k]}</SelectItem>)}</SelectContent>
        </Select>
      } />
      {q.isError ? <SectionError label="your report" onRetry={() => q.refetch()} />
        : !t || !d ? <Skeleton className="h-48 rounded-xl" />
        : (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {[
                ['Notes created', t.created.toLocaleString(), ''],
                ['Brought in', t.broughtIn.toLocaleString(), 'text-success'],
                ['Conversion', t.conversion === null ? '—' : `${t.conversion}%`, ''],
                ['Commission earned', earn.isLoading ? '…' : ugx(t.commission), 'text-success'],
              ].map(([k, v, c]) => (
                <Card key={k} className="p-3 shadow-none"><p className="text-xs text-muted-foreground">{k}</p><p className={`truncate text-xl font-bold tabular-nums ${c}`}>{v}</p></Card>
              ))}
            </div>
            <Card className="p-0 shadow-none">
              <div className="flex items-center justify-between border-b p-3">
                <p className="text-sm font-semibold">Daily performance · {LABEL[range]}</p>
                <Button size="sm" variant="outline" className="h-8" onClick={exportCsv}><Download className="mr-1 h-3.5 w-3.5" />CSV</Button>
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/60 text-xs text-muted-foreground"><tr><th className="p-2 text-left font-medium">Date</th><th className="p-2 text-right font-medium">Created</th><th className="p-2 text-right font-medium">Brought in</th></tr></thead>
                  <tbody className="divide-y">
                    {[...d.series].reverse().map((s) => (
                      <tr key={s.date}>
                        <td className="p-2">{new Date(`${s.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</td>
                        <td className="p-2 text-right tabular-nums">{s.pending}</td>
                        <td className="p-2 text-right tabular-nums text-success">{s.brought_in}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
    </div>
  );
}
