import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, subDays, startOfMonth, startOfYear, differenceInCalendarDays, startOfDay, endOfDay } from 'date-fns';
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
  const [day, setDay] = useState<Date>(() => new Date());
  const [activePreset, setActivePreset] = useState<PresetKind>('today');
  const [exporting, setExporting] = useState(false);
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

  const dayKey = toDateKey(day);
  const today = useMemo(() => new Date(), []);
  const todayKey = toDateKey(today);
  const rangeDays = Math.max(1, differenceInCalendarDays(today, day) + 1);
  const isRange = rangeDays > 1;

  const reportQuery = useQuery({
    queryKey: ['agent-products-services-report', dayKey, todayKey],
    queryFn: async (): Promise<ApsReport> => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: todayKey,
        p_from: dayKey,
      });
      if (error) throw error;
      return data as unknown as ApsReport;
    },
    staleTime: 60_000,
  });

  const rawReport = reportQuery.data;

  /** Fetch canonical schedule expectations from command center RPC (which derives from v_rent_plan_schedule). */
  const commandCenterQuery = useQuery({
    queryKey: ['agent-collections-command-center-aps', startOfDay(day).toISOString(), endOfDay(today).toISOString()],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_collections_command_center', {
        p_start: startOfDay(day).toISOString(),
        p_end: endOfDay(today).toISOString(),
        p_bucket: 'day',
      });
      if (error) throw error;
      return data as any;
    },
    staleTime: 60_000,
  });

  const commissionQuery = useQuery({
    queryKey: ['agent-commission-earned', dayKey, todayKey],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await supabase.rpc('get_agent_commission_earned' as any, {
        p_from: dayKey,
        p_to: todayKey,
      });
      if (error) throw error;
      const map: Record<string, number> = {};
      for (const row of (data as any[]) || []) map[row.agent_id] = Number(row.commission_earned) || 0;
      return map;
    },
    staleTime: 60_000,
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
    queryKey: ['agent-products-cumulative', todayKey],
    queryFn: async (): Promise<ApsCumulative> => {
      const { data, error } = await supabase.rpc('get_agent_products_cumulative' as any, { p_date: todayKey });
      if (error) throw error;
      return data as unknown as ApsCumulative;
    },
    staleTime: 60_000,
  });

  const cumulative = cumulativeQuery.data ?? null;

  const prevFrom = useMemo(() => subDays(day, rangeDays), [day, rangeDays]);
  const prevTo = useMemo(() => subDays(day, 1), [day]);
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
    staleTime: 60_000,
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
    staleTime: 60_000,
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
      downloadBlob(blob, isRange ? `agent-products-services-${dayKey}_to_${todayKey}.pdf` : `agent-products-services-${todayKey}.pdf`);
      toast.success(isRange ? 'Cumulative report downloaded' : 'Daily report downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Could not generate the report');
    } finally {
      setExporting(false);
    }
  };

  const setPreset = (kind: PresetKind) => {
    setActivePreset(kind);
    const now = new Date();
    if (kind === 'today') setDay(now);
    if (kind === 'yesterday') setDay(subDays(now, 1));
    if (kind === 'd7') setDay(subDays(now, 7));
    if (kind === 'd14') setDay(subDays(now, 14));
    if (kind === 'd30') setDay(subDays(now, 30));
    if (kind === 'd90') setDay(subDays(now, 90));
    if (kind === 'y1') setDay(subDays(now, 365));
    if (kind === 'month') setDay(startOfMonth(now));
    if (kind === 'year') setDay(startOfYear(now));
    if (kind === 'all') setDay(new Date(2015, 0, 1));
  };

  const activeLongLabel = longPresets.find(([k]) => k === activePreset)?.[1];

  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <Button
        size="sm"
        variant={activePreset === 'today' ? 'default' : 'secondary'}
        className="h-8 text-[11px]"
        onClick={() => setPreset('today')}
      >
        Today
      </Button>
      <Button
        size="sm"
        variant={activePreset === 'yesterday' ? 'default' : 'secondary'}
        className="h-8 text-[11px]"
        onClick={() => setPreset('yesterday')}
      >
        Yesterday
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant={activeLongLabel ? 'default' : 'secondary'} className="h-8 text-[11px]">
            {activeLongLabel || 'Select Period'}
            <ChevronDown className="h-3.5 w-3.5 ml-1" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="z-[200]">
          {longPresets.map(([k, l]) => (
            <DropdownMenuItem key={k} className="text-[12px]" onClick={() => setPreset(k)}>{l}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Popover>
        <PopoverTrigger asChild>
          <Button size="sm" variant="outline" className="h-8 text-[11px]">
            <CalendarIcon className="h-3.5 w-3.5 mr-1" />
            From {format(day, 'dd MMM yyyy')}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 z-[200]" align="start">
          <Calendar
            mode="single"
            selected={day}
            onSelect={(d) => d && setDay(d)}
            disabled={(d) => d > today}
            initialFocus
            className="p-3 pointer-events-auto"
          />
        </PopoverContent>
      </Popover>
      <Button
        size="sm"
        className="h-8 text-[11px]"
        disabled={!report || exporting}
        onClick={handlePdf}
      >
        {exporting ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <FileText className="h-3.5 w-3.5 mr-1" />}
        Export PDF
      </Button>
    </div>
  );
}
