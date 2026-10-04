import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { Download, FileSpreadsheet, FileText, RefreshCw, FileDown, Loader2 } from 'lucide-react';

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'custom';

interface Metrics {
  period_start: string;
  period_end: string;
  total_deposited: number;
  total_paid_out: number;
  closing_wallet_balance: number;
  deposits: Record<string, { count: number; amount: number }>;
  payouts: Record<string, { count: number; amount: number }>;
}

interface ReportRow {
  id: string;
  report_date: string;
  total_deposited: number;
  total_paid_out: number;
  closing_balance: number;
  report_version?: number;
  deposits_by_source: Metrics['deposits'];
  payouts_by_channel: Metrics['payouts'];
  pdf_path: string | null;
  xlsx_path: string | null;
  generated_at: string;
  email_sent_at: string | null;
}

// compute_wallet_report v2 (docs/HANDOVER/131): money_in excludes float WELILE
// sent to agents and hand-posted credits; payouts count cash when it actually
// left (agent float settlements + treasury-paid withdrawals).
const DEPOSIT_LABEL: Record<string, string> = {
  mtn: 'MTN', airtel: 'Airtel', bank: 'Bank', cash: 'Cash',
  gmail_auto: 'Gmail auto-credit', other: 'Other deposit requests',
};
const PAYOUT_LABEL: Record<string, string> = {
  agent_paid: 'Paid by agents from float (incl. fees)',
  treasury_bank_transfer: 'Bank transfers (treasury)',
  treasury_mtn: 'MTN (treasury)', treasury_airtel: 'Airtel (treasury)', treasury_other: 'Other',
};

interface ReportV2 {
  version: number;
  period_start: string;
  period_end: string;
  money_in: Record<string, { count: number; amount: number }>;
  money_in_total: number;
  payouts: {
    agent_paid: { withdrawals: number; amount: number };
    treasury_bank_transfer: { count: number; amount: number };
    treasury_mtn: { count: number; amount: number };
    treasury_airtel: { count: number; amount: number };
    treasury_other: { count: number; amount: number };
  };
  payouts_total: number;
  net_movement: number;
}

function toMetrics(r: ReportV2): Metrics {
  return {
    period_start: r.period_start,
    period_end: r.period_end,
    total_deposited: Number(r.money_in_total ?? 0),
    total_paid_out: Number(r.payouts_total ?? 0),
    closing_wallet_balance: Number(r.net_movement ?? 0),
    deposits: r.money_in ?? {},
    payouts: {
      agent_paid: { count: r.payouts.agent_paid.withdrawals, amount: r.payouts.agent_paid.amount },
      treasury_bank_transfer: r.payouts.treasury_bank_transfer,
      treasury_mtn: r.payouts.treasury_mtn,
      treasury_airtel: r.payouts.treasury_airtel,
      treasury_other: r.payouts.treasury_other,
    },
  };
}

function eatDayToUtcRange(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00.000+03:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
function todayEat(): string {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}
function addDays(dateStr: string, days: number): string {
  // Treat YYYY-MM-DD as a calendar date, not as an instant in EAT.
  // Creating it at 00:00+03:00 converts to the prior UTC date, which made
  // "Yesterday" jump two calendar days back in this panel.
  const d = new Date(`${dateStr}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function presetRange(p: Preset, from: string, to: string): { from: string; to: string } {
  const today = todayEat();
  if (p === 'today') return { from: today, to: today };
  if (p === 'yesterday') { const y = addDays(today, -1); return { from: y, to: y }; }
  if (p === 'week') return { from: addDays(today, -6), to: today };
  if (p === 'month') return { from: addDays(today, -29), to: today };
  return { from, to };
}

async function downloadFromBucket(path: string, filename: string) {
  const { data, error } = await supabase.storage
    .from('finops-reports')
    .createSignedUrl(path, 60 * 10);
  if (error || !data?.signedUrl) {
    toast.error(`Could not open file: ${error?.message ?? 'unknown error'}`);
    return;
  }
  // Force download in a new tab; browsers will handle disposition from the signed URL.
  const a = document.createElement('a');
  a.href = data.signedUrl;
  a.download = filename;
  a.rel = 'noopener';
  a.target = '_blank';
  document.body.appendChild(a); a.click(); a.remove();
}

export function DailyWalletReportsPanel() {
  const qc = useQueryClient();
  const today = todayEat();
  const [preset, setPreset] = useState<Preset>('week');
  const [customFrom, setCustomFrom] = useState<string>(addDays(today, -6));
  const [customTo, setCustomTo] = useState<string>(today);
  const [search, setSearch] = useState('');
  // Explicit date picker for the "Generate report" action so operators can
  // regenerate any historical day without touching the range preset above.
  const [generateDate, setGenerateDate] = useState<string>(addDays(today, -1));

  const range = useMemo(
    () => presetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const reportsQ = useQuery({
    queryKey: ['daily_wallet_reports', range.from, range.to],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('daily_wallet_reports')
        .select('*')
        .gte('report_date', range.from)
        .lte('report_date', range.to)
        .order('report_date', { ascending: false });
      if (error) throw error;
      return ((data ?? []) as unknown) as ReportRow[];
    },
  });

  // Aggregated computation for the selected range straight from the ledger.
  const aggregateQ = useQuery({
    queryKey: ['daily_wallet_reports_agg', range.from, range.to],
    queryFn: async () => {
      const { startIso } = eatDayToUtcRange(range.from);
      const { endIso } = eatDayToUtcRange(range.to);
      const { data, error } = await supabase.rpc('compute_wallet_report', {
        _start: startIso, _end: endIso,
      });
      if (error) throw error;
      return toMetrics((data as unknown) as ReportV2);
    },
  });

  const regenerate = useMutation({
    mutationFn: async (dateStr: string) => {
      const { data, error } = await supabase.functions.invoke('generate-daily-wallet-report', {
        body: { date: dateStr, skipEmail: true },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, dateStr) => {
      toast.success(`Report regenerated for ${dateStr}`);
      qc.invalidateQueries({ queryKey: ['daily_wallet_reports'] });
    },
    onError: (e: any) => toast.error(`Regenerate failed: ${e?.message ?? e}`),
  });

  const filtered = useMemo(() => {
    const rows = reportsQ.data ?? [];
    if (!search.trim()) return rows;
    const s = search.toLowerCase();
    return rows.filter(r => r.report_date.includes(s));
  }, [reportsQ.data, search]);

  const exportRangeCsv = () => {
    const rows = filtered;
    // Rows before 2026-09-25 are v1 (deposits counted float sent to agents); see handover 131.
    const header = ['Date', 'Money In', 'Paid Out', 'Net Movement', 'Report Version', 'Generated At', 'Emailed At'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.report_date,
        Math.round(r.total_deposited),
        Math.round(r.total_paid_out),
        Math.round(r.closing_balance),
        r.report_version ?? 1,
        r.generated_at,
        r.email_sent_at ?? '',
      ].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `wallet-summary-${range.from}_to_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const agg = aggregateQ.data;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
          <FileText className="h-6 w-6 text-primary" />
          Reports — Daily Wallet Financial Summary
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Computed directly from the immutable financial ledger. Automatically generated daily at 00:00 EAT and emailed to Financial Operations.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filter</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {(['today','yesterday','week','month','custom'] as Preset[]).map(p => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={preset === p ? 'default' : 'outline'}
                onClick={() => setPreset(p)}
              >
                {p === 'today' ? 'Today' : p === 'yesterday' ? 'Yesterday'
                  : p === 'week' ? 'This Week' : p === 'month' ? 'This Month' : 'Custom'}
              </Button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex flex-wrap gap-3 items-end">
              <div className="space-y-1">
                <Label className="text-xs">From (EAT)</Label>
                <Input type="date" value={customFrom} max={customTo}
                  onChange={(e) => setCustomFrom(e.target.value)} className="w-[170px]" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">To (EAT)</Label>
                <Input type="date" value={customTo} min={customFrom}
                  onChange={(e) => setCustomTo(e.target.value)} className="w-[170px]" />
              </div>
            </div>
          )}
          <div className="text-xs text-muted-foreground">
            Range: {range.from} → {range.to}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Range totals (ledger)</CardTitle>
        </CardHeader>
        <CardContent>
          {aggregateQ.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-3">
              <Skeleton className="h-20" /><Skeleton className="h-20" /><Skeleton className="h-20" />
            </div>
          ) : agg ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric label="Money In" value={formatUGX(agg.total_deposited)} />
                <Metric label="Money Paid Out" value={formatUGX(agg.total_paid_out)} />
                <Metric label="Net Movement (not a balance)" value={formatUGX(agg.closing_wallet_balance)} highlight />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <BreakdownTable title="Money in by channel" labels={DEPOSIT_LABEL} data={agg.deposits} />
                <BreakdownTable title="Paid out by who paid" labels={PAYOUT_LABEL} data={agg.payouts} />
              </div>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">No data.</div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">Generated reports in range</CardTitle>
          <div className="flex gap-2 items-center">
            <Input
              placeholder="Search date (YYYY-MM-DD)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-[200px]"
            />
            <Button size="sm" variant="outline" onClick={exportRangeCsv}>
              <FileDown className="h-4 w-4 mr-1" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {reportsQ.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-8" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No reports in this range yet.
              <div className="mt-3 flex flex-wrap gap-2 items-end justify-center">
                <div className="space-y-1 text-left">
                  <Label className="text-xs">Pick date (EAT)</Label>
                  <Input
                    type="date"
                    value={generateDate}
                    max={today}
                    onChange={(e) => setGenerateDate(e.target.value)}
                    className="w-[170px]"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => regenerate.mutate(generateDate)}
                  disabled={regenerate.isPending || !generateDate}
                >
                  {regenerate.isPending ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                    : <RefreshCw className="h-4 w-4 mr-1" />}
                  Generate report for {generateDate}
                </Button>
              </div>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-muted-foreground border-b">
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3 text-right">Money In</th>
                    <th className="py-2 pr-3 text-right">Paid Out</th>
                    <th className="py-2 pr-3 text-right">Net</th>
                    <th className="py-2 pr-3">Emailed</th>
                    <th className="py-2 pr-3">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id} className="border-b last:border-0">
                      <td className="py-2 pr-3 font-medium">{r.report_date}</td>
                      <td className="py-2 pr-3 text-right">{formatUGX(r.total_deposited)}</td>
                      <td className="py-2 pr-3 text-right">{formatUGX(r.total_paid_out)}</td>
                      <td className="py-2 pr-3 text-right">{formatUGX(r.closing_balance)}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">
                        {r.email_sent_at ? new Date(r.email_sent_at).toLocaleString() : '—'}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex flex-wrap gap-1">
                          {r.pdf_path && (
                            <Button size="sm" variant="outline"
                              onClick={() => downloadFromBucket(r.pdf_path!, `wallet-summary-${r.report_date}.pdf`)}>
                              <FileText className="h-3.5 w-3.5 mr-1" /> PDF
                            </Button>
                          )}
                          {r.xlsx_path && (
                            <Button size="sm" variant="outline"
                              onClick={() => downloadFromBucket(r.xlsx_path!, `wallet-summary-${r.report_date}.xlsx`)}>
                              <FileSpreadsheet className="h-3.5 w-3.5 mr-1" /> Excel
                            </Button>
                          )}
                          <Button size="sm" variant="ghost"
                            disabled={regenerate.isPending}
                            onClick={() => regenerate.mutate(r.report_date)}>
                            {regenerate.isPending
                              ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />
                              : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
                            Regenerate
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? 'bg-primary/5 border-primary/30' : ''}`}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-bold mt-1">{value}</div>
    </div>
  );
}

function BreakdownTable({
  title, labels, data,
}: {
  title: string;
  labels: Record<string, string>;
  data: Record<string, { count: number; amount: number }>;
}) {
  const entries = Object.entries(data);
  return (
    <div className="rounded-lg border">
      <div className="px-3 py-2 border-b bg-muted/30 text-sm font-medium">{title}</div>
      <table className="w-full text-sm">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b last:border-0">
              <td className="px-3 py-2">{labels[k] ?? k}</td>
              <td className="px-3 py-2 text-right text-muted-foreground">{v.count.toLocaleString()}</td>
              <td className="px-3 py-2 text-right font-medium">{formatUGX(v.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default DailyWalletReportsPanel;