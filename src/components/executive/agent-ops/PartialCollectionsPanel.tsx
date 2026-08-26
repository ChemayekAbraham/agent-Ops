import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2, AlertTriangle, Download, Search, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

/** Rows returned by `agent_ops_partial_collection_report`. */
interface AgentRow {
  agent_id: string;
  agent_name: string;
  agent_phone: string | null;
  paid_days: number;
  partial_days: number;
  collected: number;
  expected: number;
  shortfall: number;
  tenants_short: number;
  last_collection_at: string | null;
}

interface TenantRow {
  tenant_id: string;
  rent_request_id: string;
  tenant_name: string;
  tenant_phone: string | null;
  agent_name: string;
  agent_id: string;
  paid_days: number;
  partial_days: number;
  collected: number;
  expected: number;
  shortfall: number;
  last_collection_at: string | null;
  last_reason: string | null;
  repayment_frequency: string | null;
}

interface PartialRow {
  id: string;
  created_at: string;
  amount: number;
  expected_amount: number | null;
  shortfall_amount: number | null;
  partial_reason: string | null;
  payment_method: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  agent_name: string;
}

interface Report {
  days: number;
  generated_at: string;
  totals: {
    paid_days: number;
    partial_days: number;
    collected_total: number;
    expected_total: number;
    shortfall_total: number;
    agents_affected: number;
    tenants_affected: number;
  } | null;
  confirmed_partials_total?: number;
  by_agent: AgentRow[];
  by_tenant: TenantRow[];
  confirmed_partials: PartialRow[];
}

const PERIODS = [
  { value: 1, label: 'Today' },
  { value: 7, label: '7d' },
  { value: 30, label: '30d' },
  { value: 90, label: '90d' },
  { value: 180, label: '180d' },
] as const;
const PAGE_SIZE = 15;

/** Single CSV writer reused by every section (DRY). */
function exportCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => escape(r[h])).join(','))].join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}-${format(new Date(), 'yyyy-MM-dd')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' | 'ok' | 'bad' }) {
  const toneClass =
    tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-warning' : tone === 'ok' ? 'text-success' : 'text-foreground';
  return (
    <div className="rounded-xl border bg-card p-3">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold font-mono ${toneClass}`}>{value}</p>
    </div>
  );
}

function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min((page + 1) * pageSize, total);
  return (
    <div className="flex items-center justify-between gap-3 pt-2">
      <p className="text-xs text-muted-foreground">
        Showing <span className="font-medium text-foreground">{start}-{end}</span> of <span className="font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => onChange(page - 1)} disabled={page <= 0}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-xs tabular-nums">Page {page + 1} / {totalPages}</span>
        <Button size="sm" variant="outline" onClick={() => onChange(page + 1)} disabled={page >= totalPages - 1}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

export function PartialCollectionsPanel() {
  const [days, setDays] = useState<number>(30);
  const [search, setSearch] = useState('');
  const [partialPage, setPartialPage] = useState(0);

  const { data, isLoading, error, refetch, isRefetching } = useQuery({
    queryKey: ['agent-ops-partial-collections', days, partialPage],
    queryFn: async (): Promise<Report> => {
      const { data, error } = await supabase.rpc('agent_ops_partial_collection_report', {
        p_days: days,
        p_limit: PAGE_SIZE,
        p_offset: partialPage * PAGE_SIZE,
      });
      if (error) throw error;
      return data as unknown as Report;
    },
    staleTime: 300000,
  });

  const q = search.trim().toLowerCase();
  const agents = useMemo(
    () => (data?.by_agent || []).filter(r => !q || `${r.agent_name} ${r.agent_phone ?? ''}`.toLowerCase().includes(q)),
    [data, q],
  );
  const tenants = useMemo(
    () => (data?.by_tenant || []).filter(r => !q || `${r.tenant_name} ${r.tenant_phone ?? ''} ${r.agent_name}`.toLowerCase().includes(q)),
    [data, q],
  );
  const partials = useMemo(
    () => (data?.confirmed_partials || []).filter(r => !q || `${r.tenant_name} ${r.agent_name} ${r.partial_reason ?? ''}`.toLowerCase().includes(q)),
    [data, q],
  );

  const t = data?.totals;
  const rate = t && t.expected_total > 0 ? Math.round((t.collected_total / t.expected_total) * 1000) / 10 : 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="h-4 w-4 text-warning" />
                Partial Collections & Shortfalls
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Days where the agent recorded less than the tenant's expected amount. Derived from real amounts — no separate status.
              </p>
            </div>
            <div className="flex items-center gap-2">
              {PERIODS.map(p => (
                <Button
                  key={p.value}
                  size="sm"
                  variant={days === p.value ? 'default' : 'outline'}
                  onClick={() => { setPartialPage(0); setDays(p.value); }}
                >
                  {p.label}
                </Button>
              ))}
              <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isRefetching}>
                <RefreshCw className={`h-3.5 w-3.5 ${isRefetching ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading collection shortfalls…
            </div>
          ) : error ? (
            <p className="text-sm text-destructive">Could not load the report: {(error as Error).message}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                <Stat label="Expected" value={formatUGX(t?.expected_total ?? 0)} />
                <Stat label="Collected" value={formatUGX(t?.collected_total ?? 0)} tone="ok" />
                <Stat label="Shortfall" value={formatUGX(t?.shortfall_total ?? 0)} tone="bad" />
                <Stat label="Collection rate" value={`${rate}%`} tone={rate >= 90 ? 'ok' : 'warn'} />
                <Stat label="Partial days" value={`${t?.partial_days ?? 0} / ${t?.paid_days ?? 0}`} tone="warn" />
                <Stat label="Tenants affected" value={String(t?.tenants_affected ?? 0)} tone="warn" />
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search agent, tenant or phone…"
                  className="pl-9"
                />
              </div>

              <Tabs defaultValue="agents">
                <TabsList className="w-full overflow-x-auto justify-start">
                  <TabsTrigger value="agents">By agent ({agents.length})</TabsTrigger>
                  <TabsTrigger value="tenants">Follow-up tenants ({tenants.length})</TabsTrigger>
                  <TabsTrigger value="reasons">Recorded reasons ({partials.length})</TabsTrigger>
                </TabsList>

                <TabsContent value="agents" className="mt-3 space-y-2">
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => exportCsv('partial-collections-by-agent', agents as unknown as Record<string, unknown>[])}>
                      <Download className="h-3.5 w-3.5 mr-1.5" /> Export
                    </Button>
                  </div>
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr className="text-left">
                          <th className="p-2 font-semibold">Agent</th>
                          <th className="p-2 font-semibold text-right">Partial / paid days</th>
                          <th className="p-2 font-semibold text-right">Expected</th>
                          <th className="p-2 font-semibold text-right">Collected</th>
                          <th className="p-2 font-semibold text-right">Shortfall</th>
                          <th className="p-2 font-semibold text-right">Tenants short</th>
                        </tr>
                      </thead>
                      <tbody>
                        {agents.map(r => (
                          <tr key={r.agent_id} className="border-t">
                            <td className="p-2">
                              <p className="font-medium">{r.agent_name}</p>
                              <p className="text-[11px] text-muted-foreground">{r.agent_phone || '—'}</p>
                            </td>
                            <td className="p-2 text-right font-mono">
                              <Badge variant={r.partial_days > 0 ? 'destructive' : 'secondary'}>
                                {r.partial_days} / {r.paid_days}
                              </Badge>
                            </td>
                            <td className="p-2 text-right font-mono">{formatUGX(r.expected)}</td>
                            <td className="p-2 text-right font-mono">{formatUGX(r.collected)}</td>
                            <td className="p-2 text-right font-mono font-bold text-destructive">{formatUGX(r.shortfall)}</td>
                            <td className="p-2 text-right font-mono">{r.tenants_short}</td>
                          </tr>
                        ))}
                        {agents.length === 0 && (
                          <tr><td colSpan={6} className="p-6 text-center text-muted-foreground text-sm">No collections in this period.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>

                <TabsContent value="tenants" className="mt-3 space-y-2">
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => exportCsv('partial-collections-by-tenant', tenants as unknown as Record<string, unknown>[])}>
                      <Download className="h-3.5 w-3.5 mr-1.5" /> Export
                    </Button>
                  </div>
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr className="text-left">
                          <th className="p-2 font-semibold">Tenant</th>
                          <th className="p-2 font-semibold">Agent</th>
                          <th className="p-2 font-semibold">Plan</th>
                          <th className="p-2 font-semibold text-right">Expected</th>
                          <th className="p-2 font-semibold text-right">Collected</th>
                          <th className="p-2 font-semibold text-right">Missed</th>
                          <th className="p-2 font-semibold text-right">Partial days</th>
                          <th className="p-2 font-semibold text-right">Shortfall</th>
                          <th className="p-2 font-semibold">Last payment</th>
                          <th className="p-2 font-semibold">Last reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tenants.map(r => {
                          const missedPct = r.expected > 0 ? Math.round((r.shortfall / r.expected) * 1000) / 10 : 0;
                          return (
                            <tr key={`${r.tenant_id}-${r.rent_request_id}`} className="border-t">
                              <td className="p-2">
                                <p className="font-medium">{r.tenant_name}</p>
                                <p className="text-[11px] text-muted-foreground">{r.tenant_phone || '—'}</p>
                              </td>
                              <td className="p-2">{r.agent_name}</td>
                              <td className="p-2">
                                <Badge variant={r.repayment_frequency === 'weekly' ? 'secondary' : 'outline'} className="capitalize">
                                  {r.repayment_frequency || 'daily'}
                                </Badge>
                              </td>
                              <td className="p-2 text-right font-mono">{formatUGX(r.expected)}</td>
                              <td className="p-2 text-right font-mono">{formatUGX(r.collected)}</td>
                              <td className="p-2 text-right font-mono">
                                <Badge variant={missedPct >= 50 ? 'destructive' : missedPct > 0 ? 'secondary' : 'outline'}>
                                  {missedPct}%
                                </Badge>
                              </td>
                              <td className="p-2 text-right font-mono">{r.partial_days} / {r.paid_days}</td>
                              <td className="p-2 text-right font-mono font-bold text-destructive">{formatUGX(r.shortfall)}</td>
                              <td className="p-2 text-xs">{r.last_collection_at ? format(new Date(r.last_collection_at), 'dd MMM yy') : '—'}</td>
                              <td className="p-2 text-xs text-muted-foreground max-w-[220px] whitespace-normal break-words">{r.last_reason || '—'}</td>
                            </tr>
                          );
                        })}
                        {tenants.length === 0 && (
                          <tr><td colSpan={10} className="p-6 text-center text-muted-foreground text-sm">No shortfalls to follow up.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </TabsContent>

                <TabsContent value="reasons" className="mt-3 space-y-2">
                  <div className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => exportCsv('confirmed-partial-payments', partials as unknown as Record<string, unknown>[])}>
                      <Download className="h-3.5 w-3.5 mr-1.5" /> Export
                    </Button>
                  </div>
                  <div className="overflow-x-auto rounded-xl border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr className="text-left">
                          <th className="p-2 font-semibold">Date</th>
                          <th className="p-2 font-semibold">Tenant</th>
                          <th className="p-2 font-semibold">Agent</th>
                          <th className="p-2 font-semibold text-right">Paid</th>
                          <th className="p-2 font-semibold text-right">Expected</th>
                          <th className="p-2 font-semibold text-right">Short</th>
                          <th className="p-2 font-semibold">Reason given</th>
                        </tr>
                      </thead>
                      <tbody>
                        {partials.map(r => (
                          <tr key={r.id} className="border-t">
                            <td className="p-2 text-xs">{format(new Date(r.created_at), 'dd MMM yy HH:mm')}</td>
                            <td className="p-2">{r.tenant_name}</td>
                            <td className="p-2">{r.agent_name}</td>
                            <td className="p-2 text-right font-mono">{formatUGX(r.amount)}</td>
                            <td className="p-2 text-right font-mono">{formatUGX(Number(r.expected_amount ?? 0))}</td>
                            <td className="p-2 text-right font-mono font-bold text-destructive">{formatUGX(Number(r.shortfall_amount ?? 0))}</td>
                            <td className="p-2 text-xs text-muted-foreground max-w-[240px] whitespace-normal break-words">{r.partial_reason || '—'}</td>
                          </tr>
                        ))}
                        {partials.length === 0 && (
                          <tr><td colSpan={7} className="p-6 text-center text-muted-foreground text-sm">No agent-confirmed partial payments recorded yet in this period.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <Pagination
                    page={partialPage}
                    total={data?.confirmed_partials_total ?? partials.length}
                    pageSize={PAGE_SIZE}
                    onChange={setPartialPage}
                  />
                </TabsContent>
              </Tabs>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default PartialCollectionsPanel;
