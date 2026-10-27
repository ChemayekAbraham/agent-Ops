import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { ArrowDownLeft, ArrowUpRight, Download, FileText } from 'lucide-react';
import { allTime, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { MoneyReceivedReport } from '@/components/cfo/MoneyReceivedReport';
import { MoneyPaidOutReport } from '@/components/cfo/MoneyPaidOutReport';
import { useSourceBreakdown, type SourceTotal } from '@/components/cfo/CashPositionBreakdowns';

/** CSV summary of one report's money-source breakdown; amounts come straight from the server totals RPC. */
function exportBreakdownCsv(title: string, rows: SourceTotal[], total: { amount: number; count: number }) {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const range = allTime();
  const lines = [
    [esc(title), esc('From'), esc(range.from), esc('To'), esc(range.to)].join(','),
    '',
    [esc('Money source'), esc('Transactions'), esc('Amount (UGX)')].join(','),
    ...rows.map(r => [esc(r.label), String(r.count), String(Math.round(r.amount))].join(',')),
    [esc('Total'), String(total.count), String(Math.round(total.amount))].join(','),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_breakdown_${range.from}_${range.to}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function ReportSection({ title, icon, tone, status, rows, loading, error, onOpenReport }: {
  title: string;
  icon: React.ReactNode;
  tone: string;
  status: 'approved' | 'confirmed';
  rows: SourceTotal[];
  loading: boolean;
  error: unknown;
  onOpenReport: (total: { amount: number; count: number }) => void;
}) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  return (
    <section className="rounded-lg border border-border/70 p-4" aria-label={title}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-[11px] text-muted-foreground">
            {loading ? 'Loading…' : error ? 'Could not load breakdown' : `${formatUGX(total)} all time · ${totalCount.toLocaleString()} transactions`}
          </p>
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {rows.map(row => (
          <div key={row.key} className="flex items-center gap-3 py-2">
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">{row.label}</span>
              <span className="block text-[11px] text-muted-foreground">{row.count.toLocaleString()} transactions</span>
            </span>
            <span className="text-xs font-medium tabular-nums">{formatUGX(row.amount)}</span>
          </div>
        ))}
        {!loading && !error && rows.length > 0 && (
          <div className="flex items-center gap-3 pt-3 pb-1">
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-bold">Total</span>
              <span className="block text-[11px] text-muted-foreground">{totalCount.toLocaleString()} transactions</span>
            </span>
            <span className="text-sm font-bold tabular-nums">{formatUGX(total)}</span>
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={loading || !!error || !rows.length}
          onClick={() => { try { exportBreakdownCsv(title, rows, { amount: total, count: totalCount }); } catch { toast.error('Could not export the breakdown.'); } }}>
          <Download className="mr-1 h-4 w-4" />Export breakdown CSV
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={loading || !!error || !rows.length}
          onClick={() => onOpenReport({ amount: total, count: totalCount })}>
          <FileText className="mr-1 h-4 w-4" />Open full report
        </Button>
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground">The full report opens all time, every money source, and checks itself against these figures.</p>
    </section>
  );
}

/** "Download Reports" quick action: payout and received money reports with their money-source breakdown. */
export function CashPositionDownloadReports({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const received = useSourceBreakdown('received', 'approved');
  const paidOut = useSourceBreakdown('paid_out', 'confirmed');
  const [reportOpen, setReportOpen] = useState<'received' | 'paid_out' | null>(null);
  const [preset, setPreset] = useState<DrilldownPreset | null>(null);

  const openReport = (kind: 'received' | 'paid_out', status: 'approved' | 'confirmed') =>
    (total: { amount: number; count: number }) => {
      setPreset({
        label: 'All sources — all time',
        ...allTime(),
        status,
        expected: { amount: total.amount, count: total.count, basis: 'confirmed' },
      });
      onOpenChange(false);
      setReportOpen(kind);
    };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Payout &amp; Received Money Reports</DialogTitle>
            <DialogDescription>Confirmed money in and money out, broken down by money source, all time. Export the breakdown or open the detailed report.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <ReportSection title="Received Money Report" icon={<ArrowDownLeft className="h-4 w-4" />}
              tone="bg-success/10 text-success" status="approved"
              rows={received.data ?? []} loading={received.isLoading} error={received.error}
              onOpenReport={openReport('received', 'approved')} />
            <ReportSection title="Payout Money Report" icon={<ArrowUpRight className="h-4 w-4" />}
              tone="bg-destructive/10 text-destructive" status="confirmed"
              rows={paidOut.data ?? []} loading={paidOut.isLoading} error={paidOut.error}
              onOpenReport={openReport('paid_out', 'confirmed')} />
          </div>
        </DialogContent>
      </Dialog>
      <MoneyReceivedReport open={reportOpen === 'received'} onOpenChange={(o) => { if (!o) setReportOpen(null); }} preset={preset} />
      <MoneyPaidOutReport open={reportOpen === 'paid_out'} onOpenChange={(o) => { if (!o) setReportOpen(null); }} preset={preset} />
    </>
  );
}
