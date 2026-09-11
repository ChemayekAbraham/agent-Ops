import { useEffect, useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { format, subDays, startOfMonth, startOfYear, differenceInCalendarDays, isSameDay } from 'date-fns';
import { toast } from 'sonner';
import { FileDown, Loader2, CalendarIcon, ChevronDown, Package } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { generateAgentProductsOnlyPdf, type AgentProductsOnlyData } from '@/lib/agentProductsOnlyPdf';

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

type RangePresetKind = 'd7' | 'd14' | 'd30' | 'd90' | 'y1' | 'month' | 'year' | 'all';

const RANGE_PRESETS: [RangePresetKind, string][] = [
  ['d7', 'Last 7 days'],
  ['d14', 'Last 14 days'],
  ['d30', 'Last 30 days'],
  ['d90', 'Last 90 days'],
  ['y1', 'Last 1 year'],
  ['month', 'This month'],
  ['year', 'This year'],
  ['all', 'All time'],
];

export function AgentProductsOnlyReportSection({ className }: { className?: string }) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'single' | 'range'>('range');
  const [singleDate, setSingleDate] = useState<Date>(() => new Date());
  const [rangeFrom, setRangeFrom] = useState<Date>(() => subDays(new Date(), 29));
  const [rangeTo, setRangeTo] = useState<Date>(() => new Date());
  const [activeRangePreset, setActiveRangePreset] = useState<string | null>('d30');
  const [exporting, setExporting] = useState(false);
  const [actorName, setActorName] = useState('');

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
      if (!cancelled) setActorName(data?.full_name || user.email || 'Agent Operations Manager');
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.email]);

  const startDate = mode === 'single' ? singleDate : rangeFrom;
  const endDate = mode === 'single' ? singleDate : rangeTo;
  const dayKey = toDateKey(startDate);
  const endDateKey = toDateKey(endDate);
  const rangeDays = Math.max(1, differenceInCalendarDays(endDate, startDate) + 1);
  const isRange = mode === 'range' || rangeDays > 1;

  // 1. Fetch Agent Products Services core report (provides bikes, phones, advances, and item rows)
  const apsQuery = useQuery({
    queryKey: ['agent-products-report-core', dayKey, endDateKey],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_products_services_report' as any, {
        p_date: endDateKey,
        p_from: dayKey,
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  // 2. Fetch Boutique Merchandise overview
  const boutiqueQuery = useQuery({
    queryKey: ['agent-products-overview-boutique'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_products_overview' as any, {
        p_category: 'boutique',
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  // 3. Fetch Signages overview
  const signageQuery = useQuery({
    queryKey: ['agent-products-overview-signage'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_agent_products_overview' as any, {
        p_category: 'signage',
      });
      if (error) throw error;
      return data as any;
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  // 4. Fetch Welile Lending Agents data
  const lendingQuery = useQuery({
    queryKey: ['agent-products-lending-agents'],
    queryFn: async () => {
      const [agreementsRes, loansRes] = await Promise.all([
        (supabase as any)
          .from('lending_agent_agreement_acceptance')
          .select('agent_user_id, agreement_version, status, accepted_at')
          .eq('status', 'accepted'),
        (supabase as any)
          .from('lending_agent_loans')
          .select('id, lender_agent_id, principal_ugx, amount_repaid_ugx, status, created_at'),
      ]);

      const agreements = agreementsRes.data || [];
      const loans = loansRes.data || [];

      // Unique lender ids
      const lenderIds = [...new Set([...agreements.map((a: any) => a.agent_user_id), ...loans.map((l: any) => l.lender_agent_id)])];

      let profileMap: Record<string, { full_name: string; phone: string | null }> = {};
      if (lenderIds.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', lenderIds.slice(0, 100));
        (profs || []).forEach((p) => {
          profileMap[p.id] = { full_name: p.full_name || 'Lending Agent', phone: p.phone };
        });
      }

      // Aggregate loans by lender
      const lenderAgg: Record<
        string,
        { loans_count: number; total_lent: number; total_repaid: number; outstanding: number }
      > = {};

      let totalLent = 0;
      let totalRepaid = 0;
      let activeLoansCount = 0;

      for (const loan of loans) {
        const p = Number(loan.principal_ugx) || 0;
        const r = Number(loan.amount_repaid_ugx) || 0;
        totalLent += p;
        totalRepaid += r;
        if (loan.status === 'active' || loan.status === 'partially_repaid') {
          activeLoansCount++;
        }
        if (!lenderAgg[loan.lender_agent_id]) {
          lenderAgg[loan.lender_agent_id] = { loans_count: 0, total_lent: 0, total_repaid: 0, outstanding: 0 };
        }
        lenderAgg[loan.lender_agent_id].loans_count++;
        lenderAgg[loan.lender_agent_id].total_lent += p;
        lenderAgg[loan.lender_agent_id].total_repaid += r;
        lenderAgg[loan.lender_agent_id].outstanding += Math.max(0, p - r);
      }

      const rows = Object.entries(lenderAgg).map(([agentId, agg]) => ({
        full_name: profileMap[agentId]?.full_name || 'Lending Agent',
        phone: profileMap[agentId]?.phone || null,
        loans_count: agg.loans_count,
        total_lent: agg.total_lent,
        total_repaid: agg.total_repaid,
        outstanding: agg.outstanding,
      }));

      return {
        onboarded_count: agreements.length,
        active_loans_count: activeLoansCount,
        total_lent: totalLent,
        total_repaid: totalRepaid,
        outstanding: Math.max(0, totalLent - totalRepaid),
        rows,
      };
    },
    placeholderData: keepPreviousData,
    staleTime: 5 * 60_000,
  });

  const rawAps = apsQuery.data;
  const rawBoutique = boutiqueQuery.data;
  const rawSignage = signageQuery.data;
  const rawLending = lendingQuery.data;

  // Process and shape strictly the 6 product & service lines
  const reportData = useMemo<AgentProductsOnlyData | null>(() => {
    if (!rawAps) return null;

    const issuedRows = (rawAps.product_rows || []).filter((r: any) => r.is_issued);
    const bikeRows = issuedRows.filter((r: any) => r.product === 'bike');
    const phoneRows = issuedRows.filter((r: any) => r.product === 'smartphone');

    const bikes = {
      issued_total: Number(rawAps.bikes?.issued_total ?? bikeRows.length),
      total_value: Number(rawAps.bikes?.total_value ?? 0),
      paid: Number(rawAps.bikes?.paid ?? 0),
      outstanding: Number(rawAps.bikes?.outstanding ?? 0),
      rows: bikeRows.map((r: any) => ({
        client_name: r.client_name,
        client_phone: r.client_phone,
        item_name: r.item_name || 'Spiro EV Bike',
        value: Number(r.value) || 0,
        paid: Number(r.paid) || 0,
        outstanding: Number(r.outstanding) || 0,
        order_status: r.order_status,
        issued_date: r.issued_date || r.sale_date,
      })),
    };

    const phones = {
      issued_total: Number(rawAps.phones?.issued_total ?? phoneRows.length),
      total_value: Number(rawAps.phones?.total_value ?? 0),
      paid: Number(rawAps.phones?.paid ?? 0),
      outstanding: Number(rawAps.phones?.outstanding ?? 0),
      rows: phoneRows.map((r: any) => ({
        client_name: r.client_name,
        client_phone: r.client_phone,
        item_name: r.item_name || 'Smartphone',
        quantity: Number(r.quantity) || 1,
        value: Number(r.value) || 0,
        paid: Number(r.paid) || 0,
        outstanding: Number(r.outstanding) || 0,
        order_status: r.order_status,
        issued_date: r.issued_date || r.sale_date,
      })),
    };

    const boutique = {
      in_field_items: Number(rawBoutique?.kpis?.in_field_items ?? 0),
      in_field_amount: Number(rawBoutique?.kpis?.in_field_amount ?? 0),
      in_field_repaid: Number(rawBoutique?.kpis?.in_field_repaid ?? 0),
      in_field_outstanding: Number(rawBoutique?.kpis?.in_field_outstanding ?? 0),
      breakdown: (rawBoutique?.breakdown || []).map((b: any) => ({
        label: b.label,
        models: Number(b.models) || 0,
        reference_price: Number(b.reference_price) || 0,
        issued_qty: Number(b.issued_qty) || 0,
        issued_value: Number(b.issued_value) || 0,
        outstanding: Number(b.outstanding) || 0,
      })),
      rows: (rawBoutique?.rows || []).map((r: any) => ({
        full_name: r.full_name,
        phone: r.phone,
        location_name: r.location_name,
        items_held: Number(r.items_held) || 0,
        held_amount: Number(r.held_amount) || 0,
        repaid_amount: Number(r.repaid_amount) || 0,
        outstanding_amount: Number(r.outstanding_amount) || 0,
        product_names: r.product_names || [],
      })),
    };

    const signages = {
      in_field_items: Number(rawSignage?.kpis?.in_field_items ?? 0),
      in_field_amount: Number(rawSignage?.kpis?.in_field_amount ?? 0),
      in_field_repaid: Number(rawSignage?.kpis?.in_field_repaid ?? 0),
      in_field_outstanding: Number(rawSignage?.kpis?.in_field_outstanding ?? 0),
      rows: (rawSignage?.rows || []).map((r: any) => ({
        full_name: r.full_name,
        phone: r.phone,
        location_name: r.location_name,
        items_held: Number(r.items_held) || 0,
        held_amount: Number(r.held_amount) || 0,
        repaid_amount: Number(r.repaid_amount) || 0,
        outstanding_amount: Number(r.outstanding_amount) || 0,
        product_names: r.product_names || [],
      })),
    };

    const advances = {
      active_count: Number(rawAps.advances?.active_count ?? 0),
      issued_count: Number(rawAps.advances?.issued_count ?? 0),
      submitted: Number(rawAps.advances?.submitted ?? 0),
      approved: Number(rawAps.advances?.approved ?? 0),
      rejected: Number(rawAps.advances?.rejected ?? 0),
      issued_value: Number(rawAps.advances?.issued_today ?? 0),
      recovered: Number(rawAps.advances?.deducted_today ?? 0),
      outstanding: Number(rawAps.advances?.outstanding ?? 0),
      rows: (rawAps.advance_rows || []).map((a: any) => ({
        agent_name: a.agent_name || 'Agent',
        phone: a.phone,
        principal: Number(a.principal) || 0,
        recovered: Number(a.recovered) || 0,
        outstanding: Number(a.outstanding) || 0,
        status: a.status || 'active',
        issued_at: a.issued_at,
      })),
    };

    const lendingAgents = {
      onboarded_count: Number(rawLending?.onboarded_count ?? 0),
      active_loans_count: Number(rawLending?.active_loans_count ?? 0),
      total_lent: Number(rawLending?.total_lent ?? 0),
      total_repaid: Number(rawLending?.total_repaid ?? 0),
      outstanding: Number(rawLending?.outstanding ?? 0),
      rows: rawLending?.rows || [],
    };

    const periodLabel = isRange
      ? `${format(startDate, 'dd MMM yyyy')} – ${format(endDate, 'dd MMM yyyy')} (${rangeDays} days)`
      : format(startDate, 'dd MMM yyyy');

    return {
      periodLabel,
      isRange,
      actor: actorName || 'Agent Operations Manager',
      bikes,
      phones,
      boutique,
      signages,
      advances,
      lendingAgents,
    };
  }, [rawAps, rawBoutique, rawSignage, rawLending, startDate, endDate, isRange, rangeDays, actorName]);

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
    if (kind === 'all') setRangeFrom(new Date(2020, 0, 1));
  };

  const handleGeneratePdf = () => {
    if (!reportData) {
      toast.error('Data is still loading, please wait a moment...');
      return;
    }
    setExporting(true);
    try {
      const blob = generateAgentProductsOnlyPdf(reportData);
      const filename = isRange
        ? `agent-products-report-${dayKey}_to_${endDateKey}.pdf`
        : `agent-products-report-${dayKey}.pdf`;
      downloadBlob(blob, filename);
      toast.success('Agent Products & Services report generated successfully!');
    } catch (err: any) {
      console.error('PDF export error:', err);
      toast.error(err?.message || 'Could not generate report');
    } finally {
      setExporting(false);
    }
  };

  const activeRangePresetLabel = RANGE_PRESETS.find(([k]) => k === activeRangePreset)?.[1];
  const isLoading = apsQuery.isLoading || boutiqueQuery.isLoading;

  return (
    <Card className={cn('border-primary/20 bg-gradient-to-br from-card via-card to-primary/[0.03] shadow-sm', className)}>
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          {/* Left / Info Header */}
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Package className="h-4 w-4" />
              </div>
              <h2 className="text-base sm:text-lg font-bold tracking-tight text-foreground">
                Agent Products &amp; Services Report
              </h2>
              <Badge variant="secondary" className="bg-primary/10 text-primary border-primary/20 font-medium text-[11px]">
                Products &amp; Services Only
              </Badge>
            </div>
            <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
              Consolidated executive PDF report covering strictly the 6 lines: Motor Bikes, Smart Phones, Boutique, Signages, Agent Advances, and Lending Agents.
            </p>
          </div>

          {/* Right / Controls & Action Button */}
          <div className="flex flex-wrap items-center gap-2 lg:justify-end shrink-0">
            {/* Mode toggle */}
            <div className="inline-flex items-center rounded-lg bg-muted/70 p-0.5 border">
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
                  if (!activeRangePreset) applyRangePreset('d30');
                }}
              >
                Range
              </Button>
            </div>

            {/* Date Pickers / Presets */}
            {mode === 'single' ? (
              <>
                <Button
                  size="sm"
                  variant={isSameDay(singleDate, new Date()) ? 'default' : 'outline'}
                  className="h-8 text-[11px]"
                  onClick={() => setSingleDate(new Date())}
                >
                  Today
                </Button>
                <Button
                  size="sm"
                  variant={isSameDay(singleDate, subDays(new Date(), 1)) ? 'default' : 'outline'}
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
                  <PopoverContent className="w-auto p-0 z-[200]" align="end">
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
                    <Button size="sm" variant="outline" className="h-8 text-[11px]">
                      {activeRangePresetLabel || 'Custom Period'}
                      <ChevronDown className="h-3.5 w-3.5 ml-1" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="z-[200]">
                    {RANGE_PRESETS.map(([k, l]) => (
                      <DropdownMenuItem key={k} className="text-[12px]" onClick={() => applyRangePreset(k)}>
                        {l}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>

                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="outline" className="h-8 text-[11px]">
                      <CalendarIcon className="h-3.5 w-3.5 mr-1" />
                      {format(rangeFrom, 'dd MMM')} – {format(rangeTo, 'dd MMM yyyy')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0 z-[200]" align="end">
                    <div className="p-2 border-b text-xs font-semibold text-muted-foreground">Select Range Start</div>
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
              </>
            )}

            {/* GENERATE PDF BUTTON */}
            <Button
              size="sm"
              className="h-8 text-[12px] font-semibold gap-1.5 shadow-sm bg-primary hover:bg-primary/90 text-primary-foreground"
              disabled={isLoading || exporting}
              onClick={handleGeneratePdf}
            >
              {exporting ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Generating PDF...
                </>
              ) : (
                <>
                  <FileDown className="h-3.5 w-3.5" />
                  Generate Agent Products Report (PDF)
                </>
              )}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
