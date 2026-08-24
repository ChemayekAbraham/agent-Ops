/**
 * ProxyAgentDirectory — Partner Ops directory of every proxy agent.
 * 4 KPI cards + searchable table (avatar, contacts, notes, partners that came
 * in, join date, referred by) with a detail sheet.
 *
 * One RPC serves KPIs + page rows; the sheet uses one RPC per agent.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  FileText,
  Handshake,
  RefreshCw,
  Search,
  TrendingUp,
  UserCog,
  Users,
} from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  fetchProxyDirectory,
  proxyInitials,
  proxyStatusTone,
  PROXY_DIR_PAGE_SIZE,
  type ProxyDirRow,
} from './proxyAgentDirectory';
import { ProxyAgentDetailSheet } from './ProxyAgentDetailSheet';

const STATUS_TABS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'pending', label: 'Pending' },
  { key: 'suspended', label: 'Suspended' },
];

function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  accent,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  sub: string;
  accent: string;
}) {
  return (
    <Card className="relative overflow-hidden">
      <div className={cn('absolute inset-x-0 top-0 h-1', accent)} />
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="mt-1 truncate text-xl font-bold tabular-nums">{value}</p>
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>
          </div>
          <div className="rounded-xl border bg-muted/50 p-2">
            <Icon className="h-4 w-4 text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ProxyAgentDirectory() {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [pages, setPages] = useState(1);
  const [selected, setSelected] = useState<ProxyDirRow | null>(null);

  // Single RPC per page slice — rows accumulate client-side for "Load more".
  const pageQueries = useQuery({
    queryKey: ['proxy-agent-directory', query, status, pages],
    queryFn: async () => {
      const slices = await Promise.all(
        Array.from({ length: pages }, (_, i) =>
          fetchProxyDirectory(query, status, i * PROXY_DIR_PAGE_SIZE),
        ),
      );
      return {
        kpis: slices[0].kpis,
        total: slices[0].total,
        rows: slices.flatMap((s) => s.rows),
      };
    },
    staleTime: 30_000,
  });

  const rows = pageQueries.data?.rows ?? [];
  const kpis = pageQueries.data?.kpis;
  const total = pageQueries.data?.total ?? 0;

  const conversion = useMemo(() => {
    if (!kpis || !kpis.partners_linked) return 0;
    return Math.round((kpis.partners_came_in / kpis.partners_linked) * 100);
  }, [kpis]);

  const applySearch = () => {
    setPages(1);
    setQuery(search);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <UserCog className="h-5 w-5 text-primary" />
            Proxy Agent Directory
          </h2>
          <p className="text-xs text-muted-foreground">
            Bio data, promissory notes, linked partners and earnings for every proxy agent.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => qc.invalidateQueries({ queryKey: ['proxy-agent-directory'] })}
        >
          <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', pageQueries.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {!kpis ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px] rounded-xl" />)
        ) : (
          <>
            <KpiCard
              icon={UserCog}
              label="Proxy agents"
              value={String(kpis.agents_total)}
              sub={`${kpis.agents_approved} approved · ${kpis.agents_suspended} not active`}
              accent="bg-primary"
            />
            <KpiCard
              icon={Handshake}
              label="Partners came in"
              value={String(kpis.partners_came_in)}
              sub={`${conversion}% of ${kpis.partners_linked} linked`}
              accent="bg-emerald-500"
            />
            <KpiCard
              icon={FileText}
              label="Promissory pending"
              value={String(kpis.notes_pending)}
              sub={`${formatUGX(Number(kpis.notes_amount || 0))} total written`}
              accent="bg-amber-500"
            />
            <KpiCard
              icon={TrendingUp}
              label="Capital raised"
              value={formatUGX(Number(kpis.partner_funded || 0))}
              sub={`${formatUGX(Number(kpis.earned || 0))} commissions paid`}
              accent="bg-sky-500"
            />
          </>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && applySearch()}
            onBlur={applySearch}
            placeholder="Search name, phone, email or invite code"
            className="h-9 pl-8 text-xs"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_TABS.map((t) => (
            <Button
              key={t.key}
              size="sm"
              variant={status === t.key ? 'default' : 'outline'}
              className="h-8 text-xs"
              onClick={() => {
                setPages(1);
                setStatus(t.key);
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
      </div>

      {/* List */}
      <Card>
        <CardContent className="p-0">
          {pageQueries.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-14 w-full rounded-lg" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-12 text-center text-xs text-muted-foreground">No proxy agents match this filter.</p>
          ) : (
            <>
              {/* Desktop header */}
              <div className="hidden grid-cols-12 gap-2 border-b bg-muted/40 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-muted-foreground md:grid">
                <span className="col-span-3">Agent</span>
                <span className="col-span-3">Contacts</span>
                <span className="col-span-2 text-right">Promissory</span>
                <span className="col-span-2 text-right">Partners in</span>
                <span className="col-span-2 text-right">Joined / Referred by</span>
              </div>
              <ul className="divide-y">
                {rows.map((r) => (
                  <li key={r.agent_user_id}>
                    <button
                      type="button"
                      onClick={() => setSelected(r)}
                      className="grid w-full grid-cols-1 gap-2 px-4 py-3 text-left transition-colors hover:bg-muted/50 md:grid-cols-12 md:items-center"
                    >
                      <div className="flex items-center gap-2 md:col-span-3">
                        <Avatar className="h-9 w-9 border">
                          <AvatarImage src={r.avatar_url ?? undefined} alt={r.name} />
                          <AvatarFallback className="text-[10px] font-bold">{proxyInitials(r.name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-xs font-semibold">{r.name}</p>
                          <Badge variant="outline" className={cn('mt-0.5 text-[9px]', proxyStatusTone(r.status))}>
                            {r.status}
                          </Badge>
                        </div>
                      </div>
                      <div className="min-w-0 md:col-span-3">
                        <p className="truncate text-[11px] font-medium">{r.phone || '—'}</p>
                        <p className="truncate text-[11px] text-muted-foreground">{r.email || '—'}</p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-xs font-bold tabular-nums">{formatUGX(Number(r.notes_amount || 0))}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.notes_count} note(s) · {r.notes_pending} pending
                        </p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-xs font-bold tabular-nums text-emerald-600">{r.partners_came_in}</p>
                        <p className="text-[11px] text-muted-foreground">of {r.partners_linked} linked</p>
                      </div>
                      <div className="md:col-span-2 md:text-right">
                        <p className="text-[11px] font-medium">
                          {r.joined_at ? format(new Date(r.joined_at), 'dd MMM yyyy') : '—'}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">{r.referrer_name || 'Direct'}</p>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
                <p className="text-[11px] text-muted-foreground">
                  Showing {rows.length} of {total}
                </p>
                {rows.length < total && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs"
                    disabled={pageQueries.isFetching}
                    onClick={() => setPages((p) => p + 1)}
                  >
                    Load more
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <ProxyAgentDetailSheet
        agent={selected}
        transferTargets={rows}
        open={!!selected}
        onOpenChange={(o) => !o && setSelected(null)}
      />
    </div>
  );
}

export default ProxyAgentDirectory;
