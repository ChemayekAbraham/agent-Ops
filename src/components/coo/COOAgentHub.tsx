import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { KPICard } from '@/components/executive/KPICard';
import { AgentDetailDrawer } from './AgentDetailDrawer';
import { AgentActivityChart } from './AgentActivityChart';
import { UserAvatar } from '@/components/UserAvatar';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  Search, Users, UserCheck, UserX, Clock, Star, AlertTriangle,
  ChevronRight, ChevronLeft, Wallet, TrendingUp, Loader2
} from 'lucide-react';

type StatusFilter = 'all' | 'active' | 'inactive' | 'pending' | 'top' | 'at_risk';

interface AgentRow {
  id: string;
  full_name: string;
  phone: string;
  territory: string | null;
  last_active_at: string | null;
  tenants_count: number;
  landlords_count: number;
  total_commission: number;
  wallet_balance: number;
  status: StatusFilter;
}

const PAGE_SIZE = 50;

const STATUS_META: Record<StatusFilter, { label: string; icon: typeof Users; dotClass: string; badgeVariant: 'success' | 'destructive' | 'muted' | 'warning' }> = {
  all: { label: 'All Agents', icon: Users, dotClass: '', badgeVariant: 'muted' },
  active: { label: 'Active', icon: UserCheck, dotClass: 'bg-emerald-500', badgeVariant: 'success' },
  inactive: { label: 'Inactive', icon: UserX, dotClass: 'bg-muted-foreground', badgeVariant: 'muted' },
  pending: { label: 'Pending', icon: Clock, dotClass: 'bg-amber-500', badgeVariant: 'warning' },
  top: { label: 'Top Performer', icon: Star, dotClass: 'bg-yellow-500', badgeVariant: 'success' },
  at_risk: { label: 'At Risk', icon: AlertTriangle, dotClass: 'bg-destructive', badgeVariant: 'destructive' },
};

function classifyAgent(agent: { last_active_at: string | null; total_commission: number }): StatusFilter {
  if (!agent.last_active_at) return 'pending';
  const days = (Date.now() - new Date(agent.last_active_at).getTime()) / 86400000;
  if (agent.total_commission > 200000) return 'top';
  if (days > 30) return 'at_risk';
  if (days > 7) return 'inactive';
  return 'active';
}

const SORT_MAP: Record<string, string> = {
  name: 'full_name',
  commission: 'total_commission',
  tenants: 'tenants_count',
};

export function COOAgentHub() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [totalCount, setTotalCount] = useState(0);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'commission' | 'tenants'>('name');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [activeOnly, setActiveOnly] = useState(true);

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchAgents = useCallback(async (currentPage: number) => {
    setLoading(true);

    const sortField = SORT_MAP[sortBy] || 'full_name';
    const sortDir = sortBy === 'name' ? 'asc' : 'desc';

    const { data, error } = await supabase.rpc('get_agents_hub', {
      search_query: debouncedSearch,
      sort_field: sortField,
      sort_dir: sortDir,
      page_limit: PAGE_SIZE,
      page_offset: currentPage * PAGE_SIZE,
      active_only: activeOnly,
    });

    if (error) {
      console.error('get_agents_hub error:', error);
      setLoading(false);
      return;
    }

    const rows: AgentRow[] = (data || []).map((r: any) => {
      const row: AgentRow = {
        id: r.id,
        full_name: r.full_name || '—',
        phone: r.phone || '',
        territory: r.territory,
        last_active_at: r.last_active_at,
        tenants_count: Number(r.tenants_count) || 0,
        landlords_count: Number(r.landlords_count) || 0,
        total_commission: Number(r.total_commission) || 0,
        wallet_balance: Number(r.wallet_balance) || 0,
        status: 'active',
      };
      row.status = classifyAgent(row);
      return row;
    });

    if (data?.length) setTotalCount(Number(data[0].total_count));
    else setTotalCount(0);

    setAgents(rows);
    setLoading(false);
  }, [debouncedSearch, sortBy, activeOnly]);

  // Re-fetch on search/sort/activeOnly change — reset to page 0
  useEffect(() => {
    setPage(0);
    fetchAgents(0);
  }, [fetchAgents]);

  // Fetch when page changes (but not on initial mount handled above)
  const handlePageChange = (newPage: number) => {
    setPage(newPage);
    fetchAgents(newPage);
  };

  // Counts per category
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: agents.length, active: 0, inactive: 0, pending: 0, top: 0, at_risk: 0 };
    agents.forEach(a => { if (a.status !== 'all') c[a.status]++; });
    return c;
  }, [agents]);

  // KPIs
  const totalCommission = useMemo(() => agents.reduce((s, a) => s + a.total_commission, 0), [agents]);
  const avgWallet = useMemo(() => agents.length ? Math.round(agents.reduce((s, a) => s + a.wallet_balance, 0) / agents.length) : 0, [agents]);

  // Client-side status filter
  const visible = useMemo(() => {
    return filter === 'all' ? agents : agents.filter(a => a.status === filter);
  }, [agents, filter]);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const rangeStart = page * PAGE_SIZE + 1;
  const rangeEnd = Math.min((page + 1) * PAGE_SIZE, totalCount);

  return (
    <div className="space-y-5">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <KPICard
          title="Total Agents"
          value={totalCount.toLocaleString()}
          icon={Users}
          color="bg-primary/10 text-primary"
          loading={loading}
        />
        <KPICard
          title="Active"
          value={counts.active}
          icon={UserCheck}
          color="bg-success/10 text-success"
          loading={loading}
          subtitle={agents.length ? `${Math.round((counts.active / agents.length) * 100)}% of loaded` : undefined}
        />
        <KPICard
          title="Inactive"
          value={counts.inactive}
          icon={UserX}
          color="bg-muted text-muted-foreground"
          loading={loading}
        />
        <KPICard
          title="Pending"
          value={counts.pending}
          icon={Clock}
          color="bg-warning/10 text-warning"
          loading={loading}
        />
        <KPICard
          title="Total Commission"
          value={`UGX ${totalCommission.toLocaleString()}`}
          icon={TrendingUp}
          color="bg-primary/10 text-primary"
          loading={loading}
        />
        <KPICard
          title="Avg Wallet"
          value={`UGX ${avgWallet.toLocaleString()}`}
          icon={Wallet}
          color="bg-accent text-accent-foreground"
          loading={loading}
        />
      </div>

      {/* Agent Activity Chart */}
      <AgentActivityChart />

      {/* Filters + Search Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search agents by name, phone, territory..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-9 h-10"
          />
        </div>

        <div className="flex items-center gap-2">
          <Switch
            id="active-only"
            checked={activeOnly}
            onCheckedChange={setActiveOnly}
          />
          <Label htmlFor="active-only" className="text-xs text-muted-foreground whitespace-nowrap cursor-pointer">
            Active only
          </Label>
        </div>

        <Select value={filter} onValueChange={v => setFilter(v as StatusFilter)}>
          <SelectTrigger className="w-full sm:w-[170px] h-10">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents ({counts.all})</SelectItem>
            <SelectItem value="active">Active ({counts.active})</SelectItem>
            <SelectItem value="inactive">Inactive ({counts.inactive})</SelectItem>
            <SelectItem value="pending">Pending ({counts.pending})</SelectItem>
            <SelectItem value="top">Top Performers ({counts.top})</SelectItem>
            <SelectItem value="at_risk">At Risk ({counts.at_risk})</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sortBy} onValueChange={v => setSortBy(v as any)}>
          <SelectTrigger className="w-full sm:w-[150px] h-10">
            <SelectValue placeholder="Sort by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name">Sort: Name</SelectItem>
            <SelectItem value="commission">Sort: Commission</SelectItem>
            <SelectItem value="tenants">Sort: Tenants</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Agent Table */}
      <div className="border border-border/60 rounded-2xl overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/40 hover:bg-muted/40">
                <TableHead className="sticky left-0 bg-muted/40 z-10 min-w-[200px]">Agent</TableHead>
                <TableHead className="min-w-[110px]">Phone</TableHead>
                <TableHead className="min-w-[120px]">Territory</TableHead>
                <TableHead className="text-center min-w-[80px]">Tenants</TableHead>
                <TableHead className="text-center min-w-[90px]">Landlords</TableHead>
                <TableHead className="text-right min-w-[120px]">Commission</TableHead>
                <TableHead className="text-right min-w-[120px]">Wallet</TableHead>
                <TableHead className="min-w-[110px]">Status</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}>
                        <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                    No agents found.
                  </TableCell>
                </TableRow>
              ) : (
                visible.map(agent => {
                  const meta = STATUS_META[agent.status];
                  return (
                    <TableRow
                      key={agent.id}
                      className="cursor-pointer hover:bg-muted/30 transition-colors"
                      onClick={() => setSelectedId(agent.id)}
                    >
                      <TableCell className="sticky left-0 bg-card z-10">
                        <div className="flex items-center gap-3">
                          <div className="relative shrink-0">
                            <UserAvatar fullName={agent.full_name} size="md" />
                            {meta.dotClass && (
                              <span className={cn('absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-card', meta.dotClass)} />
                            )}
                          </div>
                          <span className="font-semibold text-sm truncate max-w-[140px]">{agent.full_name}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{agent.phone || '—'}</TableCell>
                      <TableCell className="text-sm text-muted-foreground truncate max-w-[140px]">{agent.territory || '—'}</TableCell>
                      <TableCell className="text-center font-medium">{agent.tenants_count}</TableCell>
                      <TableCell className="text-center font-medium">{agent.landlords_count}</TableCell>
                      <TableCell className="text-right font-bold">
                        <CompactAmount value={agent.total_commission} />
                      </TableCell>
                      <TableCell className="text-right font-bold">
                        <CompactAmount value={agent.wallet_balance} />
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.badgeVariant} size="sm">
                          {meta.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/40" />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>

        {/* Pagination Footer */}
        {!loading && (
          <div className="px-4 py-3 bg-muted/20 border-t border-border/40 flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {totalCount > 0
                ? `Showing ${rangeStart}–${rangeEnd} of ${totalCount} agents`
                : 'No agents'}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => handlePageChange(page - 1)}
              >
                <ChevronLeft className="h-4 w-4 mr-1" />
                Previous
              </Button>
              <span className="text-xs font-medium px-2">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page + 1 >= totalPages}
                onClick={() => handlePageChange(page + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <AgentDetailDrawer agentId={selectedId} open={!!selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}
