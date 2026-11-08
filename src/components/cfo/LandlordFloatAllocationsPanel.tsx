import { Fragment, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Loader2,
  Landmark,
  Users,
  Phone,
  CheckCircle2,
  Search,
  Wallet,
  Clock,
  ArrowRight,
  TrendingUp,
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  Download,
} from 'lucide-react';
import { format } from 'date-fns';

const PAGE_SIZE = 15;

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

const num = (n: number) => Math.round(n || 0).toLocaleString('en-US');

const getInitials = (name: string | null | undefined): string => {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

interface AllocationRow {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  landlord_id: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  mobile_money_provider: string | null;
  allocated_amount: number;
  paid_out_amount: number;
  remaining_amount: number;
  status: string;
  source: string | null;
  created_at: string;
  agent_name?: string;
  tenant_name?: string;
}

function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * CFO view: every CFO-disbursed Landlord Payout Float allocation that is
 * currently sitting on an agent's card (open or partially_paid).
 * Organized in clean, professional tabular format with 15 agents/rows per page.
 */
export function LandlordFloatAllocationsPanel() {
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'partially_paid'>('all');
  const [viewMode, setViewMode] = useState<'by-agent' | 'allocations'>('by-agent');
  const [currentPage, setCurrentPage] = useState(1);
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cfo-landlord-float-allocations'],
    queryFn: async (): Promise<AllocationRow[]> => {
      const { data, error } = await supabase
        .from('agent_landlord_float_allocations' as any)
        .select('id, agent_id, tenant_id, landlord_id, landlord_name, landlord_phone, mobile_money_provider, allocated_amount, paid_out_amount, remaining_amount, status, source, created_at')
        .in('status', ['open', 'partially_paid'])
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const list = ((data ?? []) as any[]).map((r) => ({
        ...r,
        allocated_amount: Number(r.allocated_amount) || 0,
        paid_out_amount: Number(r.paid_out_amount) || 0,
        remaining_amount: Number(r.remaining_amount) || 0,
      })) as AllocationRow[];

      const agentIds = [...new Set(list.map((r) => r.agent_id).filter(Boolean))];
      const tenantIds = [...new Set(list.map((r) => r.tenant_id).filter(Boolean) as string[])];
      const allIds = [...new Set([...agentIds, ...tenantIds])];
      const nameMap = new Map<string, string>();
      if (allIds.length) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', allIds);
        for (const p of profiles || []) nameMap.set(p.id, p.full_name || 'Unknown');
      }
      return list.map((r) => ({
        ...r,
        agent_name: nameMap.get(r.agent_id) || 'Unknown Agent',
        tenant_name: r.tenant_id ? nameMap.get(r.tenant_id) || 'Unknown Tenant' : '—',
      }));
    },
    staleTime: 15_000,
  });

  const totals = useMemo(() => {
    const allocated = rows.reduce((s, r) => s + r.allocated_amount, 0);
    const remaining = rows.reduce((s, r) => s + r.remaining_amount, 0);
    const paid = rows.reduce((s, r) => s + r.paid_out_amount, 0);
    const agents = new Set(rows.map((r) => r.agent_id)).size;
    return { allocated, remaining, paid, agents };
  }, [rows]);

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const agent = (r.agent_name ?? '').toLowerCase();
        const tenant = (r.tenant_name ?? '').toLowerCase();
        const landlord = (r.landlord_name ?? '').toLowerCase();
        const phone = (r.landlord_phone ?? '').toLowerCase();
        if (!agent.includes(q) && !tenant.includes(q) && !landlord.includes(q) && !phone.includes(q)) {
          return false;
        }
      }
      return true;
    });
  }, [rows, statusFilter, searchTerm]);

  const filteredTotals = useMemo(() => {
    const allocated = filteredRows.reduce((s, r) => s + r.allocated_amount, 0);
    const remaining = filteredRows.reduce((s, r) => s + r.remaining_amount, 0);
    const paid = filteredRows.reduce((s, r) => s + r.paid_out_amount, 0);
    return { allocated, remaining, paid };
  }, [filteredRows]);

  // Group by agent for the summary view
  const groupedAgents = useMemo(() => {
    const map = new Map<string, { agent_name: string; rows: AllocationRow[]; remaining: number; allocated: number; paid: number }>();
    for (const r of filteredRows) {
      const g = map.get(r.agent_id) ?? {
        agent_name: r.agent_name || 'Unknown Agent',
        rows: [],
        remaining: 0,
        allocated: 0,
        paid: 0,
      };
      g.rows.push(r);
      g.remaining += r.remaining_amount;
      g.allocated += r.allocated_amount;
      g.paid += r.paid_out_amount;
      map.set(r.agent_id, g);
    }
    return [...map.entries()]
      .map(([agent_id, v]) => ({ agent_id, ...v }))
      .sort((a, b) => b.remaining - a.remaining);
  }, [filteredRows]);

  // Reset page when filters, search, or view mode change
  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, viewMode]);

  // Pagination calculation
  const totalItems = viewMode === 'by-agent' ? groupedAgents.length : filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const pagedAgents = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return groupedAgents.slice(start, start + PAGE_SIZE);
  }, [groupedAgents, safePage]);

  const pagedAllocations = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, safePage]);

  // Generate compact page numbers: e.g. [1, 2, 3, '...', 10]
  const pageNumbers = useMemo(() => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      pages.push(1);
      if (safePage > 3) pages.push('...');
      const start = Math.max(2, safePage - 1);
      const end = Math.min(totalPages - 1, safePage + 1);
      for (let i = start; i <= end; i++) pages.push(i);
      if (safePage < totalPages - 2) pages.push('...');
      pages.push(totalPages);
    }
    return pages;
  }, [totalPages, safePage]);

  const toggleAgent = (agentId: string) => {
    setExpandedAgents((prev) => ({
      ...prev,
      [agentId]: !prev[agentId],
    }));
  };

  const exportCsv = () => {
    downloadCsv(
      'live-landlord-float-allocations.csv',
      ['Agent', 'Tenant', 'Landlord', 'Landlord Phone', 'MoMo Provider', 'Status', 'Allocated (UGX)', 'Paid Out (UGX)', 'Remaining (UGX)', 'Disbursed Date'],
      filteredRows.map((r) => [
        r.agent_name ?? '',
        r.tenant_name ?? '',
        r.landlord_name ?? '',
        r.landlord_phone ?? '',
        r.mobile_money_provider ?? '',
        r.status,
        r.allocated_amount,
        r.paid_out_amount,
        r.remaining_amount,
        format(new Date(r.created_at), 'yyyy-MM-dd HH:mm'),
      ]),
    );
  };

  return (
    <Card className="shadow-sm">
      <CardHeader className="p-4 sm:p-5 border-b border-border/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base font-bold flex items-center gap-2">
                <Landmark className="h-4 w-4 text-primary" />
                Live Float in Agent Custody
              </CardTitle>
              {rows.length > 0 && (
                <Badge variant="outline" className="text-xs font-mono font-medium">
                  {totals.agents} agents · {rows.length} allocations
                </Badge>
              )}
            </div>
            <CardDescription className="text-xs mt-0.5">
              Authoritative ledger register of ring-fenced float currently sitting on agent cards awaiting MoMo disbursement to landlords.
            </CardDescription>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs font-medium gap-1.5"
              disabled={!filteredRows.length}
              onClick={exportCsv}
            >
              <Download className="h-3.5 w-3.5" /> Export CSV
            </Button>
          </div>
        </div>

        {/* 3-Card Summary Strip */}
        {!isLoading && rows.length > 0 && (
          <div className="grid grid-cols-1 gap-2.5 pt-2 sm:grid-cols-3">
            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-[11px] font-semibold uppercase tracking-wider">Total Disbursed</span>
                <Wallet className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{fmt(totals.allocated)}</p>
              <p className="text-[10px] text-muted-foreground">Total earmarked principal</p>
            </div>

            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-[11px] font-semibold uppercase tracking-wider">Delivered to Landlords</span>
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              </div>
              <p className="mt-1 text-base font-bold text-emerald-700 dark:text-emerald-400 sm:text-lg">
                {fmt(totals.paid)}
              </p>
              <p className="text-[10px] text-muted-foreground">Sent via MoMo (OTP verified)</p>
            </div>

            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-[11px] font-semibold uppercase tracking-wider">Outstanding on Cards</span>
                <Clock className="h-4 w-4 text-amber-600" />
              </div>
              <p className="mt-1 text-base font-bold text-amber-700 dark:text-amber-400 sm:text-lg">
                {fmt(totals.remaining)}
              </p>
              <p className="text-[10px] text-muted-foreground">Currently held across {totals.agents} agents</p>
            </div>
          </div>
        )}

        {/* Filter, View Toggle, and Search Bar */}
        <div className="flex flex-col gap-2.5 pt-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            {/* Status Pills */}
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant={statusFilter === 'all' ? 'default' : 'ghost'}
                className={`h-7 px-2.5 text-xs font-medium rounded-full ${
                  statusFilter === 'all' ? 'shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setStatusFilter('all')}
              >
                All ({rows.length})
              </Button>
              <Button
                size="sm"
                variant={statusFilter === 'open' ? 'default' : 'ghost'}
                className={`h-7 px-2.5 text-xs font-medium rounded-full ${
                  statusFilter === 'open' ? 'shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setStatusFilter('open')}
              >
                Open ({rows.filter((r) => r.status === 'open').length})
              </Button>
              <Button
                size="sm"
                variant={statusFilter === 'partially_paid' ? 'default' : 'ghost'}
                className={`h-7 px-2.5 text-xs font-medium rounded-full ${
                  statusFilter === 'partially_paid' ? 'shadow-sm' : 'text-muted-foreground'
                }`}
                onClick={() => setStatusFilter('partially_paid')}
              >
                Partially Paid ({rows.filter((r) => r.status === 'partially_paid').length})
              </Button>
            </div>

            {/* View Mode Switcher */}
            <div className="flex items-center rounded-lg border border-border/80 bg-muted/40 p-0.5">
              <button
                type="button"
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === 'by-agent'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setViewMode('by-agent')}
              >
                Agents List ({groupedAgents.length})
              </button>
              <button
                type="button"
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === 'allocations'
                    ? 'bg-background text-foreground shadow-xs font-semibold'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setViewMode('allocations')}
              >
                All Allocations ({filteredRows.length})
              </button>
            </div>
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search agent, tenant, or landlord..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
            <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
            <p className="text-sm font-medium">Loading agent float allocations…</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-600" />
            <p className="font-semibold text-foreground">No outstanding float on agent cards</p>
            <p className="text-xs text-muted-foreground mt-0.5">All disbursed landlord float has been delivered to landlords.</p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Search className="h-10 w-10 mx-auto mb-2 text-muted-foreground/40" />
            <p className="font-semibold text-foreground">No allocations match filters</p>
            <p className="text-xs text-muted-foreground mt-0.5">Try clearing the search query or status filter.</p>
          </div>
        ) : viewMode === 'by-agent' ? (
          /* ---------------------------------------------------------------- */
          /* View 1: By Agent Summary Table (Paginated 15 Agents per page)    */
          /* ---------------------------------------------------------------- */
          <div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40 text-xs">
                    <TableHead className="font-semibold text-foreground min-w-[160px]">Agent</TableHead>
                    <TableHead className="text-center font-semibold text-foreground">Allocations</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Total Disbursed (UGX)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Paid Out (UGX)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Outstanding on Card (UGX)</TableHead>
                    <TableHead className="min-w-[130px] font-semibold text-foreground">Delivery Completion</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Breakdown</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedAgents.map((g) => {
                    const open = !!expandedAgents[g.agent_id];
                    const pct = g.allocated > 0 ? Math.min(100, Math.round((g.paid / g.allocated) * 100)) : 0;
                    return (
                      <Fragment key={g.agent_id}>
                        <TableRow className="hover:bg-muted/30 transition-colors text-xs font-medium">
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <Avatar className="h-8 w-8 rounded-full border border-border">
                                <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                                  {getInitials(g.agent_name)}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <span className="font-semibold text-foreground text-sm block leading-tight">{g.agent_name}</span>
                                <span className="text-[10px] font-mono text-muted-foreground">{g.agent_id.slice(0, 8)}</span>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell className="text-center">
                            <Badge variant="outline" className="font-mono text-xs px-2 py-0.5">
                              {g.rows.length} {g.rows.length === 1 ? 'tenant' : 'tenants'}
                            </Badge>
                          </TableCell>

                          <TableCell className="text-right font-mono text-muted-foreground">
                            {num(g.allocated)}
                          </TableCell>

                          <TableCell className="text-right font-mono text-emerald-700 dark:text-emerald-400 font-semibold">
                            {num(g.paid)}
                          </TableCell>

                          <TableCell className="text-right font-mono text-amber-700 dark:text-amber-400 font-bold">
                            {num(g.remaining)}
                          </TableCell>

                          <TableCell>
                            <div className="space-y-1">
                              <div className="flex justify-between text-[11px] font-mono text-muted-foreground">
                                <span>{pct}% complete</span>
                              </div>
                              <Progress value={pct} className="h-1.5" />
                            </div>
                          </TableCell>

                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                              onClick={() => toggleAgent(g.agent_id)}
                            >
                              {open ? 'Hide' : 'View'}
                              {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                            </Button>
                          </TableCell>
                        </TableRow>

                        {/* Expandable Sub-table for this Agent */}
                        {open && (
                          <TableRow className="bg-muted/15 hover:bg-muted/15">
                            <TableCell colSpan={7} className="p-3 sm:px-6">
                              <div className="rounded-lg border border-border/80 bg-background overflow-hidden shadow-xs">
                                <Table>
                                  <TableHeader>
                                    <TableRow className="bg-muted/40 text-[11px]">
                                      <TableHead className="font-semibold">Tenant</TableHead>
                                      <TableHead className="font-semibold">Landlord</TableHead>
                                      <TableHead className="font-semibold">Phone &amp; Network</TableHead>
                                      <TableHead className="font-semibold">Status</TableHead>
                                      <TableHead className="text-right font-semibold">Allocated</TableHead>
                                      <TableHead className="text-right font-semibold">Paid Out</TableHead>
                                      <TableHead className="text-right font-semibold">Remaining</TableHead>
                                      <TableHead className="whitespace-nowrap">Disbursed Date</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {g.rows.map((r) => (
                                      <TableRow key={r.id} className="text-xs hover:bg-muted/20">
                                        <TableCell className="font-medium text-foreground">{r.tenant_name}</TableCell>
                                        <TableCell className="font-semibold text-primary">{r.landlord_name || 'Landlord'}</TableCell>
                                        <TableCell className="font-mono text-[11px] text-muted-foreground">
                                          {r.landlord_phone || '—'} {r.mobile_money_provider ? `(${r.mobile_money_provider})` : ''}
                                        </TableCell>
                                        <TableCell>
                                          <Badge
                                            variant="outline"
                                            className={
                                              r.status === 'partially_paid'
                                                ? 'text-[9px] px-1.5 py-0 bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300'
                                                : 'text-[9px] px-1.5 py-0 bg-blue-50 text-blue-800 border-blue-300 dark:bg-blue-950/40 dark:text-blue-300'
                                            }
                                          >
                                            {r.status === 'partially_paid' ? 'Partially Paid' : 'Open'}
                                          </Badge>
                                        </TableCell>
                                        <TableCell className="text-right font-mono text-muted-foreground">{num(r.allocated_amount)}</TableCell>
                                        <TableCell className="text-right font-mono text-emerald-700 dark:text-emerald-400 font-medium">{num(r.paid_out_amount)}</TableCell>
                                        <TableCell className="text-right font-mono text-amber-700 dark:text-amber-400 font-bold">{num(r.remaining_amount)}</TableCell>
                                        <TableCell className="text-muted-foreground text-[11px] whitespace-nowrap">
                                          {format(new Date(r.created_at), 'dd MMM yyyy')}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                </TableBody>
                <TableFooter className="bg-muted/40 font-semibold text-xs border-t border-border/80">
                  <TableRow>
                    <TableCell colSpan={2} className="text-foreground font-bold">
                      Total Across All ({groupedAgents.length} {groupedAgents.length === 1 ? 'agent' : 'agents'})
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-foreground">
                      {num(filteredTotals.allocated)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-emerald-700 dark:text-emerald-400">
                      {num(filteredTotals.paid)}
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold text-amber-700 dark:text-amber-400">
                      {num(filteredTotals.remaining)}
                    </TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </div>
        ) : (
          /* ---------------------------------------------------------------- */
          /* View 2: Detailed Flat Allocations Table (Paginated 15 per page)  */
          /* ---------------------------------------------------------------- */
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40 text-xs">
                  <TableHead className="font-semibold text-foreground min-w-[140px]">Agent</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[130px]">Tenant</TableHead>
                  <TableHead className="font-semibold text-foreground min-w-[160px]">Landlord &amp; Phone</TableHead>
                  <TableHead className="font-semibold text-foreground">Status</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Allocated (UGX)</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Paid Out (UGX)</TableHead>
                  <TableHead className="text-right font-semibold text-foreground">Outstanding (UGX)</TableHead>
                  <TableHead className="min-w-[110px] font-semibold text-foreground">Delivery</TableHead>
                  <TableHead className="font-semibold text-foreground whitespace-nowrap">Disbursed Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedAllocations.map((r) => {
                  const paidPct = r.allocated_amount > 0 ? Math.min(100, Math.round((r.paid_out_amount / r.allocated_amount) * 100)) : 0;
                  return (
                    <TableRow key={r.id} className="hover:bg-muted/30 transition-colors text-xs">
                      {/* Agent */}
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-7 w-7 rounded-full border border-border">
                            <AvatarFallback className="bg-primary/10 text-primary font-bold text-[10px]">
                              {getInitials(r.agent_name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="font-medium text-foreground truncate max-w-[130px]">
                            {r.agent_name}
                          </span>
                        </div>
                      </TableCell>

                      {/* Tenant */}
                      <TableCell>
                        <span className="font-medium text-foreground">{r.tenant_name}</span>
                      </TableCell>

                      {/* Landlord & Phone */}
                      <TableCell>
                        <div>
                          <p className="font-semibold text-foreground leading-tight">{r.landlord_name || 'Landlord'}</p>
                          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-muted-foreground font-mono">
                            {r.landlord_phone && (
                              <span className="inline-flex items-center gap-1">
                                <Phone className="h-2.5 w-2.5" />
                                {r.landlord_phone}
                              </span>
                            )}
                            {r.mobile_money_provider && (
                              <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground font-sans">
                                {r.mobile_money_provider}
                              </span>
                            )}
                          </div>
                        </div>
                      </TableCell>

                      {/* Status */}
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={
                            r.status === 'partially_paid'
                              ? 'text-[10px] px-2 py-0.5 bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-950/40 dark:text-amber-300'
                              : 'text-[10px] px-2 py-0.5 bg-blue-50 text-blue-800 border-blue-300 dark:bg-blue-950/40 dark:text-blue-300'
                          }
                        >
                          {r.status === 'partially_paid' ? 'Partially Paid' : 'Open'}
                        </Badge>
                      </TableCell>

                      {/* Allocated */}
                      <TableCell className="text-right font-mono font-medium text-muted-foreground">
                        {num(r.allocated_amount)}
                      </TableCell>

                      {/* Paid Out */}
                      <TableCell className="text-right font-mono font-medium text-emerald-700 dark:text-emerald-400">
                        {num(r.paid_out_amount)}
                      </TableCell>

                      {/* Outstanding */}
                      <TableCell className="text-right font-mono font-bold text-amber-700 dark:text-amber-400">
                        {num(r.remaining_amount)}
                      </TableCell>

                      {/* Delivery Progress */}
                      <TableCell>
                        <div className="space-y-1">
                          <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                            <span>{paidPct}%</span>
                          </div>
                          <Progress value={paidPct} className="h-1.5 w-20" />
                        </div>
                      </TableCell>

                      {/* Disbursed Date */}
                      <TableCell className="text-muted-foreground whitespace-nowrap">
                        {format(new Date(r.created_at), 'dd MMM yyyy')}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
              <TableFooter className="bg-muted/40 font-semibold text-xs border-t border-border/80">
                <TableRow>
                  <TableCell colSpan={4} className="text-foreground font-bold">
                    Total Across All ({filteredRows.length} {filteredRows.length === 1 ? 'allocation' : 'allocations'})
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-foreground">
                    {num(filteredTotals.allocated)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-emerald-700 dark:text-emerald-400">
                    {num(filteredTotals.paid)}
                  </TableCell>
                  <TableCell className="text-right font-mono font-bold text-amber-700 dark:text-amber-400">
                    {num(filteredTotals.remaining)}
                  </TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        )}

        {/* ------------------------------------------------------------------ */}
        {/* Pagination Bar (Page 1, 2, 3...)                                   */}
        {/* ------------------------------------------------------------------ */}
        {!isLoading && totalItems > 0 && totalPages > 1 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4 py-3 border-t border-border/60 bg-muted/20">
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{(safePage - 1) * PAGE_SIZE + 1}</span>–
              <span className="font-semibold text-foreground">{Math.min(safePage * PAGE_SIZE, totalItems)}</span> of{' '}
              <span className="font-semibold text-foreground">{totalItems}</span> {viewMode === 'by-agent' ? 'agents' : 'allocations'}
            </p>

            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs font-medium"
                disabled={safePage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="h-3.5 w-3.5 mr-1" /> Prev
              </Button>

              <div className="flex items-center gap-1">
                {pageNumbers.map((p, idx) =>
                  typeof p === 'number' ? (
                    <Button
                      key={`page-${p}`}
                      variant={p === safePage ? 'default' : 'outline'}
                      size="sm"
                      className={`h-8 w-8 p-0 text-xs font-mono font-medium ${
                        p === safePage ? 'shadow-xs' : 'text-muted-foreground'
                      }`}
                      onClick={() => setCurrentPage(p)}
                    >
                      {p}
                    </Button>
                  ) : (
                    <span key={`dots-${idx}`} className="px-1 text-xs text-muted-foreground">
                      ...
                    </span>
                  )
                )}
              </div>

              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2.5 text-xs font-medium"
                disabled={safePage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              >
                Next <ChevronRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
