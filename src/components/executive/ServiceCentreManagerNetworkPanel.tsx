import { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Building2, ChevronLeft, ChevronRight, Loader2, Search, Users } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 15;

interface Row {
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  centre_status: string;
  centre_location: string | null;
  centre_created_at: string;
  sub_agents_managed: number;
  sub_agents_pending: number;
  houses_total: number;
  houses_verified: number;
  houses_pending: number;
  landlords_total: number;
  landlords_verified: number;
  landlords_pending: number;
  monthly_rent_verified: number;
  lc1_verified: number;
  lc1_pending: number;
  total_count: number;
}

const STATUS_CLASS: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-600',
  verified: 'bg-blue-500/15 text-blue-600',
  approved: 'bg-emerald-500/15 text-emerald-600',
  paid: 'bg-emerald-600/15 text-emerald-700',
};

/**
 * Service Centre managers and the sub-agent networks they run.
 * Every figure is aggregated server-side over the manager plus their verified
 * sub-agents, so the table never disagrees with the agent-level records.
 */
export function ServiceCentreManagerNetworkPanel() {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [page, setPage] = useState(0);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['service-centre-manager-network', term, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_service_centre_manager_network' as any, {
        p_search: term || null,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return (data || []) as unknown as Row[];
    },
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const rows = data || [];
  const total = rows[0]?.total_count ?? 0;
  const pages = Math.max(1, Math.ceil(Number(total) / PAGE_SIZE));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    setTerm(search.trim());
  };

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Building2 className="h-4 w-4 text-primary" />
          Service Centre Managers &amp; Sub-agents
          <span className="ml-auto text-xs font-normal text-muted-foreground">{Number(total)} managers</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={submit} className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search manager, phone or centre location"
            className="pl-9"
          />
        </form>

        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">No Service Centre managers match this view.</p>
        ) : (
          <>
            {/* Mobile: stacked cards */}
            <div className="space-y-3 lg:hidden">
              {rows.map((r) => (
                <div key={r.agent_id} className="rounded-xl border border-border bg-card p-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold truncate">{r.agent_name || 'Unnamed agent'}</p>
                      <p className="text-xs text-muted-foreground truncate">{r.agent_phone || '—'}</p>
                    </div>
                    <Badge variant="outline" className={cn('text-[10px] border-0 shrink-0 capitalize', STATUS_CLASS[r.centre_status] || 'bg-muted text-muted-foreground')}>
                      {r.centre_status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{r.centre_location || 'No centre description'}</p>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <Stat label="Sub-agents" value={`${Number(r.sub_agents_managed)}`} sub={Number(r.sub_agents_pending) ? `${Number(r.sub_agents_pending)} awaiting` : undefined} />
                    <Stat label="Houses" value={`${Number(r.houses_verified)}/${Number(r.houses_total)}`} sub={Number(r.houses_pending) ? `${Number(r.houses_pending)} pending` : undefined} />
                    <Stat label="Landlords" value={`${Number(r.landlords_verified)}/${Number(r.landlords_total)}`} sub={Number(r.landlords_pending) ? `${Number(r.landlords_pending)} pending` : undefined} />
                    <Stat label="LC1 verified" value={`${Number(r.lc1_verified)}`} sub={Number(r.lc1_pending) ? `${Number(r.lc1_pending)} pending` : undefined} />
                    <Stat label="Verified rent" value={formatUGX(Number(r.monthly_rent_verified))} />
                    <Stat label="Centre added" value={format(new Date(r.centre_created_at), 'dd MMM yyyy')} />
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop: table */}
            <div className="hidden lg:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="text-left py-2 pr-3 font-medium">Agent</th>
                    <th className="text-right py-2 px-3 font-medium">Sub-agents</th>
                    <th className="text-right py-2 px-3 font-medium">Houses</th>
                    <th className="text-right py-2 px-3 font-medium">Landlords</th>
                    <th className="text-right py-2 px-3 font-medium">Verified rent</th>
                    <th className="text-right py-2 px-3 font-medium">LC1 verified</th>
                    <th className="text-right py-2 pl-3 font-medium">Waiting / pending</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const waiting =
                      Number(r.sub_agents_pending) + Number(r.houses_pending) + Number(r.landlords_pending) + Number(r.lc1_pending);
                    return (
                      <tr key={r.agent_id} className="border-b border-border/60 last:border-0">
                        <td className="py-2.5 pr-3">
                          <p className="font-medium truncate max-w-[220px]">{r.agent_name || 'Unnamed agent'}</p>
                          <p className="text-xs text-muted-foreground truncate max-w-[220px]">
                            {r.agent_phone || '—'} · {r.centre_location || 'no location'}
                          </p>
                          <Badge variant="outline" className={cn('mt-1 text-[10px] border-0 capitalize', STATUS_CLASS[r.centre_status] || 'bg-muted text-muted-foreground')}>
                            {r.centre_status}
                          </Badge>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-semibold">{Number(r.sub_agents_managed)}</span>
                          {Number(r.sub_agents_pending) > 0 && (
                            <p className="text-[11px] text-amber-600">{Number(r.sub_agents_pending)} awaiting</p>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-semibold">{Number(r.houses_verified)}</span>
                          <span className="text-muted-foreground"> / {Number(r.houses_total)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <span className="font-semibold">{Number(r.landlords_verified)}</span>
                          <span className="text-muted-foreground"> / {Number(r.landlords_total)}</span>
                        </td>
                        <td className="py-2.5 px-3 text-right font-medium">{formatUGX(Number(r.monthly_rent_verified))}</td>
                        <td className="py-2.5 px-3 text-right font-semibold">{Number(r.lc1_verified)}</td>
                        <td className="py-2.5 pl-3 text-right">
                          <span className={cn('font-semibold', waiting > 0 ? 'text-amber-600' : 'text-muted-foreground')}>{waiting}</span>
                          <p className="text-[11px] text-muted-foreground">
                            {Number(r.houses_pending)}h · {Number(r.landlords_pending)}l · {Number(r.lc1_pending)}lc
                          </p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                Page {page + 1} of {pages}
                {isFetching && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
              </p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-8" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                  <ChevronLeft className="h-4 w-4" /> Prev
                </Button>
                <Button size="sm" variant="outline" className="h-8" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-2">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold truncate">{value}</p>
      {sub && <p className="text-[10px] text-amber-600">{sub}</p>}
    </div>
  );
}
