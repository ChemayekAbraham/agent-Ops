import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { format, subDays, startOfMonth, startOfYear, differenceInCalendarDays, startOfDay, endOfDay, isSameDay } from 'date-fns';
import { toast } from 'sonner';
import { FileText, Loader2, CalendarIcon, ChevronDown } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  generateAgentProductsServicesPdf, type ApsReport, type ApsCumulative,
} from '@/lib/agentProductsServicesPdf';

const toDateKey = (d: Date) => format(d, 'yyyy-MM-dd');

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type PresetKind = 'today' | 'yesterday' | 'd7' | 'd14' | 'd30' | 'd90' | 'y1' | 'month' | 'year' | 'all';

const longPresets: [PresetKind, string][] = [
  ['d7', 'Last 7 days'],
  ['d14', 'Last 14 days'],
  ['d30', 'Last 30 days'],
  ['d90', 'Last 90 days'],
  ['y1', 'Last 1 year'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
];

export function AgentProductsServicesExportButton({ className }: { className?: string }) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'single' | 'range'>('single');
  const [singleDate, setSingleDate] = useState<Date>(() => new Date());
  const [rangeFrom, setRangeFrom] = useState<Date>(() => subDays(new Date(), 6));
  const [rangeTo, setRangeTo] = useState<Date>(() => new Date());
  const [activeRangePreset, setActiveRangePreset] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [actorName, setActorName] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
      if (!cancelled) setActorName(data?.full_name || user.email || 'Agent Ops user');
    })();
    return () => { cancelled = true; };
  }, [user?.id, user?.email]);

  const startDate = mode === 'single' ? singleDate : rangeFrom;
  const endDate = mode === 'single' ? singleDate : rangeTo;

  const dayKey = toDateKey(startDate);
  const endDateKey = toDateKey(endDate);
  const rangeDays = Math.max(1, differenceInCalendarDays(endDate, startDate) + 1);
  const isRange = mode === 'range' || rangeDays > 1;

  const reportQuery = useQuery({
    queryKey: ['agent-products-services-report', dayKey, endDateKey],
    queryFn: async (): Promise<ApsReport> => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: endDateKey,
        p_from: dayKey,
      });
      if (error) throw error;
      return data as unknown as ApsReport;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rawReport = reportQuery.data;

  /** Fetch canonical schedule expectations from command center RPC (which derives from v_rent_plan_schedule). */
  const commandCenterQuery = useQuery({
    queryKey: ['agent-collections-command-center-aps', startOfDay(startDate).toISOString(), endOfDay(endDate).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: startOfDay(startDate).toISOString(),
        p_end: endOfDay(endDate).toISOString(),
        p_bucket: 'day',
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const commissionQuery = useQuery({
    queryKey: ['agent-commission-earned', dayKey, endDateKey],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase.rpc('get_agent_commission_earned' as any, {
        p_from: dayKey,
        p_to: endDateKey,
      });
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const row of (data as any[]) || []) map[row.agent_id] = Number(row.commission_earned) || 0;
      return map;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const report = useMemo(() => {
    if (!rawReport) return rawReport;
    const map = commissionQuery.data;
    const cc = commandCenterQuery.data;

    let rent = rawReport.rent;
    let rent_rows = rawReport.rent_rows || [];

    if (cc?.totals && Number(cc.totals.expected_due) !== undefined) {
      const ccAgentMap: Record<string, { expected: number; expected_daily: number }> = {};
      for (const a of cc.agents || []) {
        ccAgentMap[a.agent_id] = {
          expected: Number(a.expected) || 0,
          expected_daily: Number(a.expected_daily) || 0,
        };
      }

      const expectedDue = Number(cc.totals.expected_due) || 0;
      const days = Math.max(1, rangeDays);
      const dailyReceivable = rangeDays === 1 ? expectedDue : (expectedDue / days);

      rent = {
        ...rawReport.rent,
        expected_cumulative: expectedDue,
        daily_receivable: dailyReceivable,
        expected_days: rangeDays,
      };

      rent_rows = rent_rows.map(r => {
        const agentExp = ccAgentMap[r.agent_id];
        if (!agentExp) return r;
        return {
          ...r,
          expected_cumulative: agentExp.expected,
          daily_receivable: rangeDays === 1 ? agentExp.expected : (agentExp.expected_daily || agentExp.expected / days),
        };
      });
    }

    return {
      ...rawReport,
      rent,
      rent_rows,
      agent_float_rows: (rawReport.agent_float_rows || []).map(r => ({
        ...r,
        commission_balance: Number(map?.[(r as any).agent_id] ?? 0),
      })),
    };
  }, [rawReport, commissionQuery.data, commandCenterQuery.data, rangeDays]);

  const cumulativeQuery = useQuery({
    queryKey: ['agent-products-cumulative', endDateKey],
    queryFn: async (): Promise<ApsCumulative> => {
      const { data, error } = await supabase.rpc('get_agent_products_cumulative' as any, { p_date: endDateKey });
      if (error) throw error;
      return data as unknown as ApsCumulative;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const cumulative = cumulativeQuery.data ?? null;

  const prevFrom = useMemo(() => subDays(startDate, rangeDays), [startDate, rangeDays]);
  const prevTo = useMemo(() => subDays(startDate, 1), [startDate]);
  const prevFromKey = toDateKey(prevFrom);
  const prevToKey = toDateKey(prevTo);

  const prevQuery = useQuery({
    queryKey: ['agent-products-services-report-prev', prevFromKey, prevToKey],
    queryFn: async (): Promise<ApsReport> => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: prevToKey,
        p_from: prevFromKey,
      });
      if (error) throw error;
      return data as unknown as ApsReport;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const prevCommandCenterQuery = useQuery({
    queryKey: ['agent-collections-command-center-aps-prev', startOfDay(prevFrom).toISOString(), endOfDay(prevTo).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: startOfDay(prevFrom).toISOString(),
        p_end: endOfDay(prevTo).toISOString(),
        p_bucket: 'day',
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const prevReport = useMemo(() => {
    const rawPrev = prevQuery.data;
    if (!rawPrev) return null;
    const prevCc = prevCommandCenterQuery.data;
    if (!prevCc?.totals || Number(prevCc.totals.expected_due) === undefined) return rawPrev;

    const expectedDue = Number(prevCc.totals.expected_due) || 0;
    const days = Math.max(1, rangeDays);
    const dailyReceivable = rangeDays === 1 ? expectedDue : (expectedDue / days);

    return {
      ...rawPrev,
      rent: {
        ...rawPrev.rent,
        expected_cumulative: expectedDue,
        daily_receivable: dailyReceivable,
        expected_days: rangeDays,
      },
    };
  }, [prevQuery.data, prevCommandCenterQuery.data, rangeDays]);

  const handlePdf = () => {
    if (!report) return;
    setExporting(true);
    try {
      const blob = generateAgentProductsServicesPdf({
        report,
        actor: actorName || 'Agent Ops user',
        cumulative,
        prev: prevReport,
      });
      downloadBlob(blob, isRange ? `agent-products-services-${dayKey}_to_${endDateKey}.pdf` : `agent-products-services-${dayKey}.pdf`);
      toast.success(isRange ? 'Cumulative report downloaded' : 'Daily report downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate the report');
    } finally {
      setExporting(false);
    }
  };

  type RangePresetKind = 'd7' | 'd14' | 'd30' | 'd90' | 'y1' | 'month' | 'year' | 'all';
  const rangePresets: [RangePresetKind, string][] = [
    ['d7', 'Last 7 days'],
    ['d14', 'Last 14 days'],
    ['d30', 'Last 30 days'],
    ['d90', 'Last 90 days'],
    ['y1', 'Last 1 year'],
    ['month', 'This month'],
    ['year', 'This year'],
    ['all', 'All time'],
  ];

  const applyRangePreset = (kind: RangePresetKind) => {
    setActiveRangePreset(kind);
    const now = new Date();
    setRangeTo(now);
    if (kind === 'd7') setRangeFrom(subDays(now, 6));
    if (kind === 'd14') setRangeFrom(subDays(now, 13));
    if (kind === 'd30') setRangeFrom(subDays(now, 29));
    if (kind === 'd90') setRangeFrom(subDays(now, 89));
    if (kind === 'y1') setRangeFrom(subDays(now, 364));
    if (kind === 'month') setRangeFrom(startOfMonth(now));
    if (kind === 'year') setRangeFrom(startOfYear(now));
    if (kind === 'all') setRangeFrom(new Date(2015, 0, 1));
  };

  const activeRangePresetLabel = rangePresets.find(([k]) => k === activeRangePreset)?.[1];

  const dateSummaryLabel = mode === 'single'
    ? (isSameDay(singleDate, new Date()) ? 'Today' : isSameDay(singleDate, subDays(new Date(), 1)) ? 'Yesterday' : format(singleDate, 'dd MMM'))
    : (activeRangePresetLabel || `${format(rangeFrom, 'dd MMM')}–${format(rangeTo, 'dd MMM')}`);

  const renderDateControls = (isMobile = false) => (
    <>
      <div className="inline-flex items-center rounded-lg bg-muted/60 p-0.5 border">
        <Button
          type="button"
          size="sm"
          variant={mode === 'single' ? 'default' : 'ghost'}
          className="h-7 px-2.5 text-[11px] font-medium"
          onClick={() => setMode('single')}
        >
          Single Day
        </Button>
        <Button
          type="button"
          size="sm"
          variant={mode === 'range' ? 'default' : 'ghost'}
          className="h-7 px-2.5 text-[11px] font-medium"
          onClick={() => {
            setMode('range');
            if (!activeRangePreset) applyRangePreset('d7');
          }}
        >
          Range
        </Button>
      </div>

      {mode === 'single' ? (
        <>
          <Button
            size="sm"
            variant={isSameDay(singleDate, new Date()) ? 'default' : 'secondary'}
            className="h-8 text-[11px]"
            onClick={() => setSingleDate(new Date())}
          >
            Today
          </Button>
          <Button
            size="sm"
            variant={isSameDay(singleDate, subDays(new Date(), 1)) ? 'default' : 'secondary'}
            className="h-8 text-[11px]"
            onClick={() => setSingleDate(subDays(new Date(), 1))}
          >
            Yesterday
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 text-[11px]">
                <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                {format(singleDate, 'dd MMM yyyy')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[200]" align="start">
              <Calendar
                mode="single"
                selected={singleDate}
                onSelect={(d) => d && setSingleDate(d)}
                disabled={(d) => d > new Date()}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>
        </>
      ) : (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant={activeRangePreset ? 'default' : 'secondary'} className="h-8 text-[11px]">
                {activeRangePresetLabel || 'Select Period'}
                <ChevronDown className="h-3.5 w-3.5 ml-1" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="z-[200]">
              {rangePresets.map(([k, l]) => (
                <DropdownMenuItem key={k} className="text-[12px]" onClick={() => applyRangePreset(k)}>{l}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 text-[11px]">
                <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                From {format(rangeFrom, 'dd MMM yyyy')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[200]" align="start">
              <Calendar
                mode="single"
                selected={rangeFrom}
                onSelect={(d) => {
                  if (d) {
                    setRangeFrom(d);
                    if (d > rangeTo) setRangeTo(d);
                    setActiveRangePreset(null);
                  }
                }}
                disabled={(d) => d > new Date()}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 text-[11px]">
                <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                To {format(rangeTo, 'dd MMM yyyy')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[200]" align="start">
              <Calendar
                mode="single"
                selected={rangeTo}
                onSelect={(d) => {
                  if (d) {
                    setRangeTo(d);
                    if (d < rangeFrom) setRangeFrom(d);
                    setActiveRangePreset(null);
                  }
                }}
                disabled={(d) => d > new Date()}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>
        </>
      )}
    </>
  );

  return (
    <div className={cn('w-full sm:w-auto', className)}>
      {/* Mobile view: Collapsed by default */}
      <div className="sm:hidden w-full space-y-2">
        <div className="flex items-center gap-2 w-full">
          <Button
            size="sm"
            className="h-9 text-xs font-semibold flex-1 justify-center"
            disabled={!report || exporting}
            onClick={handlePdf}
          >
            {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1.5" />}
            {isRange ? 'Export Cumulative PDF' : 'Export Daily PDF'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 px-2.5 text-xs font-medium gap-1 shrink-0 border-border/80"
            onClick={() => setMobileOpen((prev) => !prev)}
            aria-label="Toggle export date options"
          >
            <CalendarIcon className="h-3.5 w-3.5 text-primary" />
            <span className="text-[11px] font-semibold">{dateSummaryLabel}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-200', mobileOpen && 'rotate-180')} />
          </Button>
        </div>

        <Collapsible open={mobileOpen} onOpenChange={setMobileOpen}>
          <CollapsibleContent className="p-2.5 bg-muted/40 border border-border/60 rounded-xl space-y-2 animate-in fade-in-50 duration-150">
            <div className="flex flex-wrap items-center gap-2">
              {renderDateControls(true)}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Desktop view: Uncollapsed */}
      <div className="hidden sm:flex flex-wrap items-center gap-2 max-w-full">
        {renderDateControls(false)}
        <Button
          size="sm"
          className="h-8 text-[11px]"
          disabled={!report || exporting}
          onClick={handlePdf}
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
          {isRange ? 'Export Cumulative PDF' : 'Export Daily PDF'}
        </Button>
      </div>
    </div>
  );
}
