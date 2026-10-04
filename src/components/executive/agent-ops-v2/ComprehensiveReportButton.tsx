import { useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { FileDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  addDays, differenceInCalendarDays, endOfMonth, endOfYear, format, startOfMonth,
  startOfYear, subDays, subMonths, subYears,
} from 'date-fns';
import type { ApsReport } from '@/lib/agentProductsServicesPdf';
import {
  buildAgentOpsComprehensiveReportHtml, openAgentOpsComprehensiveReport,
  type AgentPopulation,
} from '@/lib/agentOpsComprehensiveReport';

import { useAuth } from '@/hooks/useAuth';

/**
 * Single source of truth for the report window. Every page of the exported
 * report is rendered from the one window selected here.
 */
type PeriodKey =
  | 'today' | 'yesterday' | 'last5' | 'last7' | 'weekend'
  | 'this_month' | 'prev_month' | 'this_year' | 'prev_year' | 'custom';

const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'last5', label: 'Last 5 days' },
  { key: 'last7', label: 'Last 7 days' },
  { key: 'weekend', label: 'Last weekend (Sat–Sun)' },
  { key: 'this_month', label: 'This month' },
  { key: 'prev_month', label: 'Previous month' },
  { key: 'this_year', label: 'This year' },
  { key: 'prev_year', label: 'Previous year' },
  { key: 'custom', label: 'Custom range' },
];

const key = (d: Date) => format(d, 'yyyy-MM-dd');

function resolveWindow(period: PeriodKey, customFrom: string, customTo: string) {
  const today = new Date();
  switch (period) {
    case 'today': return { from: key(today), to: key(today) };
    case 'yesterday': {
      const y = subDays(today, 1);
      return { from: key(y), to: key(y) };
    }
    case 'last5': return { from: key(subDays(today, 4)), to: key(today) };
    case 'last7': return { from: key(subDays(today, 6)), to: key(today) };
    case 'weekend': {
      // Most recent completed Saturday–Sunday pair.
      let sunday = today;
      while (sunday.getDay() !== 0) sunday = subDays(sunday, 1);
      const saturday = subDays(sunday, 1);
      return { from: key(saturday), to: key(sunday) };
    }
    case 'this_month': return { from: key(startOfMonth(today)), to: key(today) };
    case 'prev_month': {
      const m = subMonths(today, 1);
      return { from: key(startOfMonth(m)), to: key(endOfMonth(m)) };
    }
    case 'this_year': return { from: key(startOfYear(today)), to: key(today) };
    case 'prev_year': {
      const y = subYears(today, 1);
      return { from: key(startOfYear(y)), to: key(endOfYear(y)) };
    }
    case 'custom':
    default:
      return { from: customFrom || key(today), to: customTo || key(today) };
  }
}

export function ComprehensiveReportButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<PeriodKey>('this_month');
  const [customFrom, setCustomFrom] = useState(key(startOfMonth(new Date())));
  const [customTo, setCustomTo] = useState(key(new Date()));
  const [busy, setBusy] = useState(false);

  const window_ = useMemo(() => resolveWindow(period, customFrom, customTo), [period, customFrom, customTo]);
  const periodLabel = PERIOD_OPTIONS.find(p => p.key === period)?.label ?? 'Custom range';

  const fetchReport = async (from: string, to: string): Promise<ApsReport> => {
    const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
      p_date: to,
      p_from: from,
    });
    if (error) throw error;
    return data as unknown as ApsReport;
  };

  /**
   * Canonical agent network counts. Kept separate from the window-scoped
   * report so network size is never inferred from role records or from
   * recruited-but-never-operational sub-agent links.
   */
  const fetchPopulation = async (from: string, to: string): Promise<AgentPopulation | null> => {
    const { data, error } = await supabase.rpc('get_agent_operational_population' as any, {
      p_as_of: to,
      p_from: from,
    });
    if (error) return null;
    return (data as unknown as AgentPopulation) ?? null;
  };

  const handleGenerate = async () => {
    const { from, to } = window_;
    if (from > to) {
      toast.error('The start date must be on or before the end date.');
      return;
    }
    setBusy(true);
    try {
      const span = Math.max(0, differenceInCalendarDays(new Date(to), new Date(from)));
      const prevTo = key(subDays(new Date(from), 1));
      const prevFrom = key(subDays(new Date(prevTo), span));

      const [report, prev, population] = await Promise.all([
        fetchReport(from, to),
        fetchReport(prevFrom, prevTo).catch(() => null),
        fetchPopulation(from, to).catch(() => null),
      ]);

      const html = buildAgentOpsComprehensiveReportHtml({
        report,
        prev,
        population,
        fromDate: from,
        toDate: to,
        periodLabel,
        actor: (user?.user_metadata?.full_name as string | undefined) || user?.email || 'Agent Operations',
      });
      openAgentOpsComprehensiveReport(html);

      setOpen(false);
      toast.success('Comprehensive report ready — use “Save as PDF / Print”.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not generate the report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button size="sm" variant="outline" className="gap-2" onClick={() => setOpen(true)}>
        <FileDown className="h-4 w-4" />
        Comprehensive Report
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Agent Operations Comprehensive Report</DialogTitle>
            <DialogDescription>
              Choose one reporting period. Every section of the report — collections, advances, service centres,
              products and performance — is built from this window only.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Reporting period</Label>
              <Select value={period} onValueChange={(v) => setPeriod(v as PeriodKey)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map(o => (
                    <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {period === 'custom' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="aor-from">From</Label>
                  <Input id="aor-from" type="date" value={customFrom} max={customTo}
                    onChange={(e) => setCustomFrom(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="aor-to">To</Label>
                  <Input id="aor-to" type="date" value={customTo} min={customFrom} max={key(addDays(new Date(), 0))}
                    onChange={(e) => setCustomTo(e.target.value)} />
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Window: {format(new Date(`${window_.from}T00:00:00`), 'dd MMM yyyy')} –{' '}
              {format(new Date(`${window_.to}T00:00:00`), 'dd MMM yyyy')} (Africa/Kampala)
            </p>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={handleGenerate} disabled={busy} className="gap-2">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
              Generate report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
