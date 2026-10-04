import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { UserAvatar } from '@/components/UserAvatar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Activity, AlertCircle, FileText, Download, FileDown, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { formatDistanceToNow, subHours, subDays, format } from 'date-fns';
import type { DateRange } from '../AgentOpsHomeView';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

const PAGE_SIZE = 25;
const FETCH_CAP = 1000;
const ALL = '__all__';

function getRangeStart(range: DateRange): Date {
  if (range === '24h') return subHours(new Date(), 24);
  if (range === '7d') return subDays(new Date(), 7);
  return subDays(new Date(), 30);
}

interface RawRequest {
  id: string;
  agent_id: string;
  created_at: string;
  status: string | null;
  house_category: string | null;
  rent_amount: number | null;
}

interface ActiveAgentRow {
  agent_id: string;
  requestCount: number;
  lastRequestAt: string;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
}

/**
 * Active Agents drill-down — agents who posted ≥1 rent (tenant) request
 * in the selected window. Shows request count and last request time per agent.
 * Filterable by request status and house category.
 * Source of truth: `rent_requests.created_at` + `rent_requests.agent_id`.
 */
export function ActiveAgentsList({ range }: { range: DateRange }) {
  const rangeStart = useMemo(() => getRangeStart(range).toISOString(), [range]);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [statusFilter, setStatusFilter] = useState<string>(ALL);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['agent-ops-drill', 'active-agents-v2', range],
    queryFn: async () => {
      const { data: reqs, error } = await supabase
        .from('rent_requests')
        .select('id, agent_id, created_at, status, house_category, rent_amount')
        .gte('created_at', rangeStart)
        .not('agent_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(FETCH_CAP);
      if (error) throw error;

      const rows = (reqs ?? []) as RawRequest[];
      const statusSet = new Set<string>();
      const categorySet = new Set<string>();
      rows.forEach((r) => {
        if (r.status) statusSet.add(r.status);
        if (r.house_category) categorySet.add(r.house_category);
      });

      // Aggregate profile lookup is delayed until after filter to avoid
      // fetching profiles for filtered-out agents.
      return {
        rows,
        statuses: Array.from(statusSet).sort(),
        categories: Array.from(categorySet).sort(),
        capped: rows.length >= FETCH_CAP,
      };
    },
    staleTime: 60_000,
  });

  // Aggregate filtered rows → per-agent counts.
  const filtered = useMemo(() => {
    const rows = data?.rows ?? [];
    const matches = rows.filter((r) => {
      if (statusFilter !== ALL && r.status !== statusFilter) return false;
      if (categoryFilter !== ALL && r.house_category !== categoryFilter) return false;
      return true;
    });
    const agg = new Map<string, { count: number; last: string }>();
    const byAgent = new Map<string, RawRequest[]>();
    matches.forEach((r) => {
      const existing = agg.get(r.agent_id);
      if (!existing) agg.set(r.agent_id, { count: 1, last: r.created_at });
      else {
        existing.count += 1;
        if (r.created_at > existing.last) existing.last = r.created_at;
      }
      const list = byAgent.get(r.agent_id);
      if (list) list.push(r);
      else byAgent.set(r.agent_id, [r]);
    });
    return { agentIds: Array.from(agg.keys()), agg, byAgent, totalRequests: matches.length };
  }, [data?.rows, statusFilter, categoryFilter]);

  // Fetch profiles for filtered agent set.
  const { data: profileMap } = useQuery({
    queryKey: ['agent-ops-drill-profiles', filtered.agentIds.slice().sort().join(',')],
    queryFn: async () => {
      if (filtered.agentIds.length === 0) return new Map<string, any>();
      const map = new Map<string, any>();
      const BATCH = 50;
      for (let i = 0; i < filtered.agentIds.length; i += BATCH) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, avatar_url, phone')
          .in('id', filtered.agentIds.slice(i, i + BATCH));
        (profs ?? []).forEach((p: any) => map.set(p.id, p));
      }
      return map;
    },
    enabled: filtered.agentIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const aggregatedRowsAll: ActiveAgentRow[] = useMemo(() => {
    return filtered.agentIds
      .map((id) => {
        const a = filtered.agg.get(id)!;
        const p = profileMap?.get(id);
        return {
          agent_id: id,
          requestCount: a.count,
          lastRequestAt: a.last,
          full_name: p?.full_name ?? null,
          avatar_url: p?.avatar_url ?? null,
          phone: p?.phone ?? null,
        };
      })
      .sort(
        (a, b) =>
          b.requestCount - a.requestCount ||
          b.lastRequestAt.localeCompare(a.lastRequestAt),
      );
  }, [filtered, profileMap]);

  const searchTerm = search.trim().toLowerCase();
  const aggregatedRows: ActiveAgentRow[] = useMemo(() => {
    if (!searchTerm) return aggregatedRowsAll;
    return aggregatedRowsAll.filter((r) =>
      (r.full_name ?? '').toLowerCase().includes(searchTerm) ||
      r.agent_id.toLowerCase().includes(searchTerm) ||
      (r.phone ?? '').toLowerCase().includes(searchTerm),
    );
  }, [aggregatedRowsAll, searchTerm]);

  const filtersActive = statusFilter !== ALL || categoryFilter !== ALL || searchTerm.length > 0;

  const rangeLabel = range === '24h' ? 'Last 24 hours' : range === '7d' ? 'Last 7 days' : 'Last 30 days';
  const exportStamp = format(new Date(), 'yyyyMMdd-HHmm');
  const filterSuffix = `${statusFilter !== ALL ? `_status-${statusFilter}` : ''}${categoryFilter !== ALL ? `_cat-${categoryFilter}` : ''}`;

  const handleExportCsv = () => {
    const header = ['Rank', 'Agent name', 'Phone', 'Agent ID', 'Tenant requests', 'Last request (UTC)'];
    const escape = (v: string | number | null | undefined) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      `# Active Agents — ${rangeLabel}`,
      `# Status: ${statusFilter === ALL ? 'All' : statusFilter} · Category: ${categoryFilter === ALL ? 'All' : categoryFilter}`,
      `# Active agents: ${aggregatedRows.length} · Total tenant requests: ${filtered.totalRequests}`,
      header.join(','),
      ...aggregatedRows.map((r, i) =>
        [
          i + 1,
          r.full_name ?? '',
          r.phone ?? '',
          r.agent_id,
          r.requestCount,
          r.lastRequestAt,
        ].map(escape).join(','),
      ),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `active-agents_${range}${filterSuffix}_${exportStamp}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(14);
    doc.text('Active Agents', 40, 40);
    doc.setFontSize(10);
    doc.text(rangeLabel, 40, 58);
    doc.text(
      `Status: ${statusFilter === ALL ? 'All' : statusFilter}  ·  Category: ${categoryFilter === ALL ? 'All' : categoryFilter}`,
      40,
      72,
    );
    doc.text(
      `Active agents: ${aggregatedRows.length.toLocaleString()}  ·  Tenant requests: ${filtered.totalRequests.toLocaleString()}`,
      40,
      86,
    );
    autoTable(doc, {
      startY: 100,
      head: [['#', 'Agent', 'Phone', 'Agent ID', 'Requests', 'Last request']],
      body: aggregatedRows.map((r, i) => [
        i + 1,
        r.full_name ?? 'Unnamed agent',
        r.phone ?? '—',
        r.agent_id,
        r.requestCount,
        format(new Date(r.lastRequestAt), 'yyyy-MM-dd HH:mm'),
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [245, 158, 11] },
      columnStyles: {
        0: { cellWidth: 30 },
        4: { halign: 'right', cellWidth: 60 },
      },
    });
    doc.save(`active-agents_${range}${filterSuffix}_${exportStamp}.pdf`);
  };

  const exportButtons = (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-2 text-xs gap-1.5"
        onClick={handleExportCsv}
        disabled={aggregatedRows.length === 0}
      >
        <Download className="h-3.5 w-3.5" />
        CSV
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 px-2 text-xs gap-1.5"
        onClick={handleExportPdf}
        disabled={aggregatedRows.length === 0}
      >
        <FileDown className="h-3.5 w-3.5" />
        PDF
      </Button>
    </div>
  );

  const filterBar = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setVisible(PAGE_SIZE); }}
          placeholder="Search name, phone, ID…"
          className="h-8 w-[200px] pl-7 pr-7 text-xs"
        />
        {search && (
          <button
            type="button"
            onClick={() => { setSearch(''); setVisible(PAGE_SIZE); }}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted text-muted-foreground"
            aria-label="Clear search"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setVisible(PAGE_SIZE); }}>
        <SelectTrigger className="h-8 w-[140px] text-xs">
          <SelectValue placeholder="Status" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All statuses</SelectItem>
          {(data?.statuses ?? []).map((s) => (
            <SelectItem key={s} value={s}>{s}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v); setVisible(PAGE_SIZE); }}>
        <SelectTrigger className="h-8 w-[160px] text-xs">
          <SelectValue placeholder="House category" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All categories</SelectItem>
          {(data?.categories ?? []).map((c) => (
            <SelectItem key={c} value={c}>{c}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {filtersActive && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2 text-xs"
          onClick={() => { setStatusFilter(ALL); setCategoryFilter(ALL); setSearch(''); setVisible(PAGE_SIZE); }}
        >
          Clear
        </Button>
      )}
      </div>
      {exportButtons}
    </div>
  );

  if (isLoading) {
    return (
      <div className="space-y-2 overflow-y-auto max-h-[50vh] pr-1">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2 text-center">
        <AlertCircle className="h-6 w-6 text-destructive" />
        <p className="text-sm text-muted-foreground">Failed to load active agents.</p>
        <Button size="sm" variant="outline" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  if (aggregatedRows.length === 0) {
    return (
      <div className="flex flex-col gap-3 min-h-0">
        {filterBar}
        <div className="flex flex-col items-center justify-center py-10 gap-2 text-center">
          <Activity className="h-8 w-8 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">
            {filtersActive ? 'No active agents match these filters.' : 'No active agents in this window yet.'}
          </p>
          <p className="text-xs text-muted-foreground">
            {filtersActive
              ? 'Try clearing the status or category filter.'
              : 'An agent becomes active by posting ≥1 tenant request.'}
          </p>
        </div>
      </div>
    );
  }

  const shown = aggregatedRows.slice(0, visible);

  return (
    <div className="flex flex-col gap-2 min-h-0">
      {filterBar}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{aggregatedRows.length.toLocaleString()}</span> active agents ·
          <span className="font-semibold text-foreground"> {filtered.totalRequests.toLocaleString()}</span> tenant requests
          {filtersActive && <span className="text-amber-600 dark:text-amber-400"> (filtered)</span>}
        </p>
        {data?.capped && (
          <Badge variant="outline" className="text-[10px]">Showing latest {FETCH_CAP}</Badge>
        )}
      </div>

      <div className="space-y-2 overflow-y-auto max-h-[50vh] pr-1">
        {shown.map((r, idx) => {
          const isOpen = expanded.has(r.agent_id);
          const reqs = filtered.byAgent.get(r.agent_id) ?? [];
          const toggle = () => {
            setExpanded((prev) => {
              const next = new Set(prev);
              if (next.has(r.agent_id)) next.delete(r.agent_id);
              else next.add(r.agent_id);
              return next;
            });
          };
          return (
            <div
              key={r.agent_id}
              className="rounded-xl border border-border/50 bg-card overflow-hidden"
            >
              <button
                type="button"
                onClick={toggle}
                className="w-full flex items-center gap-3 p-2.5 min-h-[52px] text-left hover:bg-muted/40 transition-colors"
                aria-expanded={isOpen}
              >
                <div className="text-xs font-semibold text-muted-foreground tabular-nums w-5 text-center shrink-0">
                  {idx + 1}
                </div>
                <UserAvatar avatarUrl={r.avatar_url} fullName={r.full_name ?? undefined} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground truncate">
                    {r.full_name || r.phone || 'Unnamed agent'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Last request {formatDistanceToNow(new Date(r.lastRequestAt), { addSuffix: true })}
                  </p>
                </div>
                <Badge
                  variant="secondary"
                  className="gap-1 text-[11px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30 shrink-0"
                >
                  <FileText className="h-3 w-3" />
                  {r.requestCount.toLocaleString()}
                </Badge>
                {isOpen ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                )}
              </button>
              {isOpen && (
                <div className="border-t border-border/50 bg-muted/20 px-2.5 py-2 space-y-1.5">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-1">
                    {reqs.length.toLocaleString()} {reqs.length === 1 ? 'request' : 'requests'} in {rangeLabel.toLowerCase()}
                  </p>
                  {reqs.map((req) => (
                    <div
                      key={req.id}
                      className="flex items-center gap-2 rounded-lg bg-background border border-border/40 px-2 py-1.5"
                    >
                      <Badge
                        variant="outline"
                        className="text-[10px] font-medium shrink-0"
                      >
                        {req.status ?? 'unknown'}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-medium text-foreground truncate">
                          {req.house_category ?? 'Uncategorized'}
                          {req.rent_amount != null && (
                            <span className="text-muted-foreground font-normal">
                              {' · '}UGX {Number(req.rent_amount).toLocaleString()}
                            </span>
                          )}
                        </p>
                        <p className="text-[10px] text-muted-foreground tabular-nums">
                          {format(new Date(req.created_at), 'MMM d, HH:mm')} · #{req.id.slice(0, 8)}
                        </p>
                      </div>
                      <a
                        href={`/coo/rent-requests?id=${req.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline shrink-0"
                      >
                        View
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {visible < aggregatedRows.length && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setVisible((v) => v + PAGE_SIZE)}
          >
            Load more ({aggregatedRows.length - visible} remaining)
          </Button>
        )}
      </div>
    </div>
  );
}
