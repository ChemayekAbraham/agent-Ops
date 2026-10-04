import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, Landmark, Users, Phone, CheckCircle2, Search, Home, ChevronDown, ChevronRight } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { FileDown } from 'lucide-react';
import { downloadAuditPdf, pdfTimestampLabel } from '@/lib/pdfAuditReport';

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

type Period = '30d' | 'all';

interface FundedLandlordRow {
  id: string;
  rent_request_id: string;
  status: string;
  rent_amount: number;
  tenant_id: string;
  tenant_name: string;
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string | null;
  agent_id: string;
  agent_name: string;
  created_at: string;
  allocated_amount: number | null;
  paid_out_amount: number | null;
  remaining_amount: number | null;
  allocation_status: string | null;
}

export function AlreadyFundedLandlordsPanel() {
  const [search, setSearch] = useState('');
  const [period, setPeriod] = useState<Period>('30d');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cfo-already-funded-landlords'],
    queryFn: async (): Promise<FundedLandlordRow[]> => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(
          'id, status, rent_amount, tenant_id, landlord_id, agent_id, assigned_agent_id, created_at,' +
          'landlord:landlords!rent_requests_landlord_id_fkey(name, phone)'
        )
        .in('status', ['funded', 'repaying', 'completed'])
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      const raw = (data ?? []) as any[];

      // Resolve agent + tenant names in one batch (tenant_id FK points to auth.users,
      // so we cannot embed profiles directly via PostgREST).
      const personIds = [
        ...new Set(
          raw
            .flatMap((r) => [r.assigned_agent_id || r.agent_id, r.tenant_id])
            .filter(Boolean),
        ),
      ];
      const nameMap = new Map<string, string>();
      if (personIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', personIds);
        for (const p of profiles || []) nameMap.set(p.id, p.full_name || 'Unknown');
      }

      // Float allocations have no FK to rent_requests, so fetch them separately.
      const requestIds = raw.map((r) => r.id);
      const allocMap = new Map<string, any>();
      if (requestIds.length) {
        const { data: allocs } = await supabase
          .from('agent_landlord_float_allocations')
          .select('rent_request_id, allocated_amount, paid_out_amount, remaining_amount, status')
          .in('rent_request_id', requestIds);
        for (const a of allocs || []) {
          if (a.rent_request_id && !allocMap.has(a.rent_request_id)) {
            allocMap.set(a.rent_request_id, a);
          }
        }
      }

      return raw.map((r) => {
        const tenantName = nameMap.get(r.tenant_id) || 'Unknown Tenant';
        const landlordName = r.landlord?.name || 'Unknown Landlord';
        const landlordPhone = r.landlord?.phone || null;
        const agentId = r.assigned_agent_id || r.agent_id;
        const alloc = allocMap.get(r.id);
        return {
          id: r.id,
          rent_request_id: r.id,
          status: r.status,
          rent_amount: Number(r.rent_amount) || 0,
          tenant_id: r.tenant_id,
          tenant_name: tenantName,
          landlord_id: r.landlord_id,
          landlord_name: landlordName,
          landlord_phone: landlordPhone,
          agent_id: agentId,
          agent_name: nameMap.get(agentId) || 'Unknown Agent',
          created_at: r.created_at,
          allocated_amount: alloc ? Number(alloc.allocated_amount) : null,
          paid_out_amount: alloc ? Number(alloc.paid_out_amount) : null,
          remaining_amount: alloc ? Number(alloc.remaining_amount) : null,
          allocation_status: alloc ? alloc.status : null,
        };
      });
    },
    staleTime: 15_000,
  });

  const filtered = useMemo(() => {
    let base = rows;
    if (fromDate || toDate) {
      const fromMs = fromDate ? new Date(fromDate + 'T00:00:00').getTime() : -Infinity;
      const toMs = toDate ? new Date(toDate + 'T23:59:59').getTime() : Infinity;
      base = base.filter((r) => {
        const t = new Date(r.created_at).getTime();
        return t >= fromMs && t <= toMs;
      });
    } else if (period === '30d') {
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      base = base.filter((r) => new Date(r.created_at).getTime() >= cutoff);
    }
    if (!search.trim()) return base;
    const q = search.trim().toLowerCase();
    return base.filter(
      (r) =>
        r.landlord_name.toLowerCase().includes(q) ||
        r.tenant_name.toLowerCase().includes(q) ||
        r.agent_name.toLowerCase().includes(q) ||
        (r.landlord_phone || '').includes(q),
    );
  }, [rows, search, period, fromDate, toDate]);

  const handleDownloadPdf = async () => {
    const headers = [
      'Landlord',
      'Phone',
      'Tenant',
      'Agent',
      'Status',
      'Float',
      'Funded On',
      'Rent (UGX)',
      'Allocated (UGX)',
      'Paid (UGX)',
      'Remaining (UGX)',
    ];
    const rowsOut = filtered.map((r) => [
      r.landlord_name,
      r.landlord_phone || '',
      r.tenant_name,
      r.agent_name,
      r.status,
      r.allocation_status || '',
      format(new Date(r.created_at), 'dd MMM yyyy'),
      Math.round(r.rent_amount).toLocaleString(),
      Math.round(r.allocated_amount ?? r.rent_amount).toLocaleString(),
      Math.round(r.paid_out_amount ?? 0).toLocaleString(),
      Math.round(r.remaining_amount ?? r.rent_amount).toLocaleString(),
    ]);
    const filters: string[] = [];
    if (fromDate || toDate) {
      filters.push(`Date range: ${fromDate || 'earliest'} → ${toDate || 'today'}`);
    } else {
      filters.push(`Period: ${period === '30d' ? 'Last 30 days' : 'All time'}`);
    }
    if (search.trim()) filters.push(`Search: "${search.trim()}"`);
    const stamp = new Date().toISOString().slice(0, 10);
    await downloadAuditPdf(`already-funded-landlords_${stamp}.pdf`, headers, rowsOut, {
      title: 'Already Funded Landlords — CFO Report',
      subtitle: `Generated by Welile CFO · ${pdfTimestampLabel(new Date().toISOString())}`,
      filters,
      footerLabel: 'Welile · Already Funded Landlords',
      kpis: [
        { label: 'Total Rent Funded', value: fmt(totals.totalRent), hint: `${filtered.length} records`, accent: [30, 64, 175] },
        { label: 'Allocated to Agents', value: fmt(totals.totalAllocated), hint: 'Float sent to agent cards', accent: [146, 52, 234] },
        { label: 'Paid to Landlords', value: fmt(totals.totalPaid), hint: 'Forwarded by agents', accent: [22, 163, 74] },
        { label: 'Still on Agent Cards', value: fmt(totals.totalRemaining), hint: 'Awaiting landlord payout', accent: [234, 88, 12] },
        { label: 'Landlords', value: String(totals.landlords), hint: 'Unique landlords funded', accent: [15, 118, 110] },
        { label: 'Tenants', value: String(totals.tenants), hint: 'Unique tenants covered', accent: [219, 39, 119] },
      ],
    });
  };

  const totals = useMemo(() => {
    const totalRent = filtered.reduce((s, r) => s + r.rent_amount, 0);
    const totalAllocated = filtered.reduce(
      (s, r) => s + (r.allocated_amount ?? r.rent_amount),
      0,
    );
    const totalPaid = filtered.reduce((s, r) => s + (r.paid_out_amount ?? 0), 0);
    const totalRemaining = filtered.reduce(
      (s, r) => s + (r.remaining_amount ?? r.rent_amount),
      0,
    );
    const landlords = new Set(filtered.map((r) => r.landlord_id)).size;
    const tenants = new Set(filtered.map((r) => r.tenant_id)).size;
    return { totalRent, totalAllocated, totalPaid, totalRemaining, landlords, tenants };
  }, [filtered]);

  // Group by landlord
  const grouped = useMemo(() => {
    const map = new Map<
      string,
      {
        landlord_id: string;
        landlord_name: string;
        landlord_phone: string | null;
        rows: FundedLandlordRow[];
        totalRent: number;
        totalPaid: number;
        totalRemaining: number;
      }
    >();
    for (const r of filtered) {
      const g = map.get(r.landlord_id) ?? {
        landlord_id: r.landlord_id,
        landlord_name: r.landlord_name,
        landlord_phone: r.landlord_phone,
        rows: [],
        totalRent: 0,
        totalPaid: 0,
        totalRemaining: 0,
      };
      g.rows.push(r);
      g.totalRent += r.rent_amount;
      g.totalPaid += r.paid_out_amount ?? 0;
      g.totalRemaining += r.remaining_amount ?? r.rent_amount;
      map.set(r.landlord_id, g);
    }
    return [...map.values()].sort((a, b) => b.totalRent - a.totalRent);
  }, [filtered]);

  const statusBadge = (status: string) => {
    switch (status) {
      case 'funded':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      case 'repaying':
        return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'completed':
        return 'bg-purple-100 text-purple-700 border-purple-200';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const allocBadge = (status: string | null) => {
    if (!status) return 'bg-muted text-muted-foreground border-border';
    switch (status) {
      case 'fully_paid':
        return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case 'partially_paid':
        return 'bg-amber-100 text-amber-700 border-amber-200';
      case 'open':
        return 'bg-blue-100 text-blue-700 border-blue-200';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Landmark className="h-4 w-4 text-primary" />
              Already Funded Landlords
              {rows.length > 0 && (
                <Badge variant="outline" className="text-[10px] ml-1 bg-primary/10 text-primary border-primary/30">
                  {totals.landlords} landlords · {totals.tenants} tenants
                </Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border overflow-hidden shrink-0">
                <Button
                  type="button"
                  variant={period === '30d' && !fromDate && !toDate ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 rounded-none text-xs px-2"
                  onClick={() => { setPeriod('30d'); setFromDate(''); setToDate(''); }}
                >
                  Last 30 days
                </Button>
                <Button
                  type="button"
                  variant={period === 'all' && !fromDate && !toDate ? 'default' : 'ghost'}
                  size="sm"
                  className="h-8 rounded-none text-xs px-2"
                  onClick={() => { setPeriod('all'); setFromDate(''); setToDate(''); }}
                >
                  All time
                </Button>
              </div>
              <div className="flex items-center gap-1">
                <Input
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="h-8 text-xs w-[140px]"
                  aria-label="From date"
                />
                <span className="text-xs text-muted-foreground">→</span>
                <Input
                  type="date"
                  value={toDate}
                  onChange={(e) => setToDate(e.target.value)}
                  className="h-8 text-xs w-[140px]"
                  aria-label="To date"
                />
                {(fromDate || toDate) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs px-2"
                    onClick={() => { setFromDate(''); setToDate(''); }}
                  >
                    Clear
                  </Button>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1"
                onClick={handleDownloadPdf}
                disabled={filtered.length === 0}
              >
                <FileDown className="h-3.5 w-3.5" />
                PDF
              </Button>
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search landlord, tenant, agent…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-8 text-xs"
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Landlords whose rent has already been funded by the CFO (status: funded, repaying, or completed)
            {fromDate || toDate
              ? ` between ${fromDate || 'earliest'} and ${toDate || 'today'}`
              : period === '30d'
                ? ' in the last 30 days'
                : ''}
            .
            Shows payout float allocation and how much the agent has already forwarded to the landlord.
            Tap a landlord to expand the tenants funded under them.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
              <p className="font-medium">No funded landlords found</p>
              <p className="text-xs">
                {search.trim() ? 'Try a different search term.' : 'No rent requests have reached funded status yet.'}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Totals strip */}
              <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 rounded-lg border-2 border-primary/20 bg-primary/5 p-3 text-center">
                <div>
                  <p className="text-[10px] text-muted-foreground">Total Rent Funded</p>
                  <p className="font-bold text-sm text-primary">{fmt(totals.totalRent)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Allocated to Agents</p>
                  <p className="font-bold text-sm text-[#9234EA]">{fmt(totals.totalAllocated)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Paid to Landlords</p>
                  <p className="font-bold text-sm text-emerald-600">{fmt(totals.totalPaid)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Still on Agent Cards</p>
                  <p className="font-bold text-sm text-orange-600">{fmt(totals.totalRemaining)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">Records</p>
                  <p className="font-bold text-sm">{filtered.length}</p>
                </div>
              </div>

              {/* Compact flat list — one row per landlord, expandable to tenants */}
              <ScrollArea className="max-h-[600px]">
                <div className="divide-y rounded-lg border">
                  {grouped.map((g) => {
                    const isOpen = expanded.has(g.landlord_id);
                    return (
                      <div key={g.landlord_id}>
                        <button
                          type="button"
                          onClick={() => toggleExpanded(g.landlord_id)}
                          className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {isOpen ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            )}
                            <Home className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <p className="font-semibold text-sm truncate">{g.landlord_name}</p>
                            {g.landlord_phone && (
                              <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                <Phone className="h-2.5 w-2.5" />
                                {g.landlord_phone}
                              </span>
                            )}
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 shrink-0">
                              {g.rows.length} tenant{g.rows.length === 1 ? '' : 's'}
                            </Badge>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-sm text-primary">{fmt(g.totalRent)}</p>
                            {g.totalPaid > 0 && (
                              <p className="text-[10px] text-emerald-600">
                                paid {fmt(g.totalPaid)} · rem {fmt(g.totalRemaining)}
                              </p>
                            )}
                          </div>
                        </button>
                        {isOpen && (
                          <div className="divide-y bg-muted/10">
                            {g.rows.map((r) => (
                              <div
                                key={r.id}
                                className="flex items-start gap-2 pl-9 pr-3 py-2 text-xs hover:bg-muted/20 transition-colors"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <Users className="h-3 w-3 text-muted-foreground shrink-0" />
                                    <p className="font-medium truncate">{r.tenant_name}</p>
                                    <span className="text-[10px] text-muted-foreground">via</span>
                                    <p className="font-medium truncate text-muted-foreground">{r.agent_name}</p>
                                  </div>
                                  <div className="flex items-center gap-2 flex-wrap mt-1 text-[10px] text-muted-foreground">
                                    <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${statusBadge(r.status)}`}>
                                      {r.status}
                                    </Badge>
                                    {r.allocation_status && (
                                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${allocBadge(r.allocation_status)}`}>
                                        float: {r.allocation_status}
                                      </Badge>
                                    )}
                                    <span>{format(new Date(r.created_at), 'dd MMM yyyy')}</span>
                                    <span className="text-muted-foreground/60">
                                      {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                                    </span>
                                  </div>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="font-bold text-sm">{fmt(r.rent_amount)}</p>
                                  {r.remaining_amount != null && (
                                    <p className="text-[10px] text-muted-foreground">
                                      {fmt(r.paid_out_amount ?? 0)} paid / {fmt(r.remaining_amount)} rem
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
