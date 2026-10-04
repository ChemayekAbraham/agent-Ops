import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { format, startOfDay, subDays, startOfMonth } from 'date-fns';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { useAuth } from '@/hooks/useAuth';
import {
  ShieldCheck, Search, RefreshCw, Loader2, TrendingUp, AlertTriangle,
  Gauge, Users, CalendarCheck, Phone, Award, Flame, FileDown,
} from 'lucide-react';
import { useTenantRepaymentReliability, type ReliabilityRow } from '@/hooks/useTenantRepaymentReliability';
import { generateTenantReliabilityReportPdf } from '@/lib/tenantReliabilityReportPdf';

type Preset = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'month';

const PRESETS: { key: Preset; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
];


type BandKey = 'all' | 'excellent' | 'good' | 'watch' | 'risk';

const BAND_META: Record<Exclude<BandKey, 'all'>, { label: string; chip: string; ring: string; note: string }> = {
  excellent: {
    label: 'Gold — pays daily',
    chip: 'bg-emerald-500/15 text-emerald-700 border-emerald-300',
    ring: 'text-emerald-600',
    note: '0–1 missed day. Prime candidate for a bigger rent plan.',
  },
  good: {
    label: 'Reliable — 1–3 missed days',
    chip: 'bg-lime-500/15 text-lime-700 border-lime-300',
    ring: 'text-lime-600',
    note: 'Stays inside the 3-missed-day tolerance through the cycle.',
  },
  watch: {
    label: 'Watch — 4–7 missed days',
    chip: 'bg-amber-500/15 text-amber-700 border-amber-300',
    ring: 'text-amber-600',
    note: 'Slipping. One agent visit usually pulls this back.',
  },
  risk: {
    label: 'At risk — 8+ missed days',
    chip: 'bg-destructive/10 text-destructive border-destructive/30',
    ring: 'text-destructive',
    note: 'Escalate to the agent and consider a repayment reset.',
  },
};

function ScoreDial({ score, band }: { score: number; band: ReliabilityRow['band'] }) {
  const pct = Math.max(0, Math.min(100, score));
  const tone = BAND_META[band].ring;
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg viewBox="0 0 36 36" className="h-12 w-12 -rotate-90">
        <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-muted" />
        <circle
          cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" strokeLinecap="round"
          className={`${tone} stroke-current transition-all`}
          strokeDasharray={`${(pct / 100) * 97.4} 97.4`}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-[11px] font-black ${tone}`}>
        {pct}
      </span>
    </div>
  );
}

/**
 * Tenant Repayment Reliability — a rent-repayment risk score.
 *
 * The score is computed server-side from each tenant's active rent plan
 * (expected daily repayment vs what the ledger-backed collections actually
 * recorded) so it always agrees with Missed Days and Daily Collections:
 *   coverage 45 · missed-day discipline 25 · payment recency 20 · progress 10
 * A tenant is "marked" reliable while cumulative missed days stay at 3 or less
 * for the whole cycle.
 */
export function TenantRepaymentReliabilityPanel() {
  const { data, isLoading, isFetching, refetch, error } = useTenantRepaymentReliability(800);
  const { user } = useAuth();
  const [band, setBand] = useState<BandKey>('all');
  const [search, setSearch] = useState('');
  const [preset, setPreset] = useState<Preset>('today');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [exporting, setExporting] = useState(false);

  const allRows = data?.rows ?? [];
  const summary = data?.summary;

  /** Report period → ISO bounds. Custom pickers win over presets; a single day = From only. */
  const range = useMemo<{ from: string | null; to: string | null }>(() => {
    if (dateFrom || dateTo) {
      return {
        from: dateFrom ? new Date(`${dateFrom}T00:00:00`).toISOString() : null,
        to: dateTo ? new Date(`${dateTo}T23:59:59.999`).toISOString() : null,
      };
    }
    const now = new Date();
    if (preset === 'all') return { from: null, to: null };
    if (preset === 'today') return { from: startOfDay(now).toISOString(), to: null };
    if (preset === 'yesterday') {
      return {
        from: startOfDay(subDays(now, 1)).toISOString(),
        to: new Date(startOfDay(now).getTime() - 1).toISOString(),
      };
    }
    if (preset === '7d') return { from: startOfDay(subDays(now, 6)).toISOString(), to: null };
    if (preset === 'month') return { from: startOfMonth(now).toISOString(), to: null };
    return { from: startOfDay(subDays(now, 29)).toISOString(), to: null };
  }, [preset, dateFrom, dateTo]);

  const periodActive = Boolean(range.from || range.to);

  /** Date scope only — the score, band and every figure stay exactly as computed server-side. */
  const rows = useMemo(() => {
    if (!periodActive) return allRows;
    const fromMs = range.from ? new Date(range.from).getTime() : null;
    const toMs = range.to ? new Date(range.to).getTime() : null;
    return allRows.filter(r => {
      if (!r.start_at) return false;
      const t = new Date(r.start_at).getTime();
      if (Number.isNaN(t)) return false;
      if (fromMs !== null && t < fromMs) return false;
      if (toMs !== null && t > toMs) return false;
      return true;
    });
  }, [allRows, periodActive, range]);

  const counts = useMemo(() => ({
    all: rows.length,
    excellent: rows.filter(r => r.band === 'excellent').length,
    good: rows.filter(r => r.band === 'good').length,
    watch: rows.filter(r => r.band === 'watch').length,
    risk: rows.filter(r => r.band === 'risk').length,
  }), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (band !== 'all' && r.band !== band) return false;
      if (!q) return true;
      return (
        (r.tenant_name || '').toLowerCase().includes(q) ||
        (r.tenant_phone || '').toLowerCase().includes(q) ||
        (r.agent_name || '').toLowerCase().includes(q)
      );
    });
  }, [rows, band, search]);

  const avgScore = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;

  const periodLabel = periodActive
    ? `${range.from ? format(new Date(range.from), 'dd MMM yyyy') : 'Start'} → ${range.to ? format(new Date(range.to), 'dd MMM yyyy') : 'Today'}`
    : 'All time';

  const handleExport = () => {
    setExporting(true);
    try {
      if (!filtered.length) {
        toast.error('No scored plans match these filters — nothing to export');
        return;
      }
      const blob = generateTenantReliabilityReportPdf(filtered, {
        band,
        search: search.trim() || null,
        dateFrom: range.from,
        dateTo: range.to,
        totalScored: allRows.length,
        outstandingTotal: Number(summary?.outstanding_total ?? 0),
        generatedBy: user?.email ?? null,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `welile-repayment-reliability-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(`Reliability report downloaded (${filtered.length.toLocaleString()} plans)`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate the report');
    } finally {
      setExporting(false);
    }
  };


  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive/40 bg-destructive/5">
        <CardContent className="p-4">
          <p className="text-sm font-semibold text-destructive">Could not compute reliability scores</p>
          <p className="text-xs text-destructive/80 mt-1">{(error as Error).message}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Headline */}
      <Card className="border-2 border-primary/40 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent">
        <CardContent className="p-3.5 flex flex-wrap items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/15">
            <ShieldCheck className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black text-foreground">Tenant Repayment Reliability</p>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Score per active rent plan: coverage of expected daily repayments, missed days, payment recency and plan
              progress. Tenants staying within 3 missed days for the cycle are marked reliable.
            </p>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => { hapticTap(); void refetch(); }} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </CardContent>
      </Card>

      {/* KPI strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Active plans scored', value: String(periodActive ? counts.all : (summary?.tenants ?? counts.all)), icon: Users, tone: 'text-primary' },
          { label: 'Marked reliable (≤3 missed)', value: String(periodActive ? rows.filter(r => r.reliable).length : (summary?.reliable ?? counts.excellent + counts.good)), icon: Award, tone: 'text-emerald-600' },
          { label: 'Average score', value: `${avgScore}/100`, icon: Gauge, tone: 'text-blue-600' },
          { label: 'Outstanding on book', value: formatUGX(periodActive ? rows.reduce((s, r) => s + r.outstanding, 0) : Number(summary?.outstanding_total ?? 0)), icon: TrendingUp, tone: 'text-amber-600' },
        ].map(k => (
          <Card key={k.label} className="border">
            <CardContent className="p-2.5">
              <div className="flex items-center gap-1.5">
                <k.icon className={`h-3.5 w-3.5 ${k.tone}`} />
                <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground leading-tight">{k.label}</p>
              </div>
              <p className="mt-1 text-base font-black text-foreground font-mono tabular-nums">{k.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Report period + PDF export */}
      <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground w-full sm:w-auto">Report period</span>
          {PRESETS.map(p => (
            <Button
              key={p.key}
              type="button"
              size="sm"
              variant={!dateFrom && !dateTo && preset === p.key ? 'default' : 'outline'}
              className="h-7 px-2 text-[11px]"
              onClick={() => { hapticTap(); setPreset(p.key); setDateFrom(''); setDateTo(''); }}
            >
              {p.label}
            </Button>
          ))}
          <Badge variant="secondary" className="text-[10px] font-bold">{periodLabel}</Badge>
          <Badge variant="outline" className="text-[10px]">{filtered.length.toLocaleString()} on screen</Badge>
        </div>
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-end gap-2">
          <div className="space-y-1 w-full sm:w-auto">
            <Label className="text-[10px] text-muted-foreground">From (single day: set From only)</Label>
            <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 w-full sm:w-[150px] text-xs" />
          </div>
          <div className="space-y-1 w-full sm:w-auto">
            <Label className="text-[10px] text-muted-foreground">To</Label>
            <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 w-full sm:w-[150px] text-xs" />
          </div>
          {(dateFrom || dateTo) && (
            <Button type="button" size="sm" variant="ghost" className="h-8 text-[11px]" onClick={() => { setDateFrom(''); setDateTo(''); }}>
              Clear dates
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            className="h-8 text-xs gap-1.5 w-full sm:w-auto sm:ml-auto"
            onClick={handleExport}
            disabled={exporting || isLoading}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
            Export PDF
          </Button>
        </div>
        <p className="text-[10px] text-muted-foreground">
          Period filters rent plans by plan start date. The PDF exports exactly the {filtered.length.toLocaleString()} plans
          these filters match — same scores, bands, coverage and outstanding figures shown here.
        </p>
      </div>


      {/* Band filters */}
      <div className="flex flex-wrap gap-1.5">
        {(['all', 'excellent', 'good', 'watch', 'risk'] as BandKey[]).map(b => (
          <Button
            key={b}
            size="sm"
            variant={band === b ? 'default' : 'outline'}
            className="h-8 gap-1.5 text-[11px]"
            onClick={() => { hapticTap(); setBand(b); }}
          >
            {b === 'all' ? 'All' : BAND_META[b].label}
            <Badge variant="secondary" className="text-[10px] px-1">{counts[b]}</Badge>
          </Button>
        ))}
      </div>

      {band !== 'all' && (
        <p className="text-[11px] text-muted-foreground px-1">{BAND_META[band].note}</p>
      )}

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search tenant, phone or agent"
          className="pl-9 h-10 rounded-xl"
        />
      </div>

      {/* Roster */}
      <div className="space-y-2">
        {filtered.map(r => {
          const meta = BAND_META[r.band];
          return (
            <Card key={r.rent_request_id} className="border">
              <CardContent className="p-3">
                <div className="flex items-start gap-3">
                  <ScoreDial score={r.score} band={r.band} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-sm font-bold text-foreground truncate">{r.tenant_name || 'Unnamed tenant'}</p>
                      <Badge variant="outline" className={`text-[10px] ${meta.chip}`}>{meta.label}</Badge>
                      {r.reliable && (
                        <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-700 border-emerald-300 gap-1">
                          <Flame className="h-3 w-3" /> On time
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2">
                      {r.tenant_phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{r.tenant_phone}</span>}
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" /> Agent: <span className="font-semibold text-foreground">{r.agent_name || 'Unassigned'}</span>
                        {r.agent_phone ? ` · ${r.agent_phone}` : ''}
                      </span>
                    </p>

                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-1 text-[11px]">
                      <span className="text-muted-foreground">Rent <span className="font-bold text-foreground font-mono">{formatUGX(r.rent_amount)}</span></span>
                      <span className="text-muted-foreground">Daily <span className="font-bold text-foreground font-mono">{formatUGX(r.daily)}</span></span>
                      <span className="text-muted-foreground">Outstanding <span className="font-bold text-foreground font-mono">{formatUGX(r.outstanding)}</span></span>
                      <span className="text-muted-foreground">Coverage <span className="font-bold text-foreground">{r.coverage_pct}%</span></span>
                      <span className="text-muted-foreground">Missed days <span className={`font-bold ${r.missed_days <= 3 ? 'text-emerald-600' : r.missed_days <= 7 ? 'text-amber-600' : 'text-destructive'}`}>{r.missed_days}</span></span>
                      <span className="text-muted-foreground">Paid days <span className="font-bold text-foreground">{r.paid_days}/{r.expected_days}</span></span>
                      <span className="text-muted-foreground">Longest gap <span className="font-bold text-foreground">{r.longest_gap}d</span></span>
                      <span className="text-muted-foreground inline-flex items-center gap-1">
                        <CalendarCheck className="h-3 w-3" />
                        Last paid <span className="font-bold text-foreground">
                          {r.days_since_last_pay === null ? 'never' : r.days_since_last_pay === 0 ? 'today' : `${r.days_since_last_pay}d ago`}
                        </span>
                      </span>
                    </div>

                    <div className="mt-2">
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mb-1">
                        <span>Cycle progress</span>
                        <span className="font-bold text-foreground">{r.progress_pct}%</span>
                      </div>
                      <Progress value={r.progress_pct} className="h-1.5" />
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {filtered.length === 0 && (
          <Card className="border">
            <CardContent className="p-6 flex items-center gap-2 justify-center">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No tenants match this filter.</p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
