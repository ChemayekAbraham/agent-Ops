/**
 * Tenant Location Corrections — Tenant Ops workspace.
 *
 * Every tenant whose saved location is not yet matched to the approved Uganda
 * location dataset, with their handling agent. Correcting a tenant removes them
 * from this list immediately. Nothing but the location is ever written.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  MapPin,
  Search,
  Loader2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CheckCircle2,
  Check,
  User,
  Phone,
  Pencil,
  X,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  legacyLocationLabel,
  useTenantLocationCorrectionAgents,
  useTenantLocationCorrections,
  useTenantLocationProgress,
  type TenantLocationCorrectionRow,
} from '@/hooks/useTenantLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

const PAGE_SIZE = 25;

export function TenantLocationCorrectionsHub() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<TenantLocationCorrectionRow | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentQuery, setAgentQuery] = useState('');
  const [agentQueryDebounced, setAgentQueryDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => setAgentQueryDebounced(agentQuery), 250);
    return () => clearTimeout(t);
  }, [agentQuery]);

  const agents = useTenantLocationCorrectionAgents(agentQueryDebounced);
  const agentOptions = agents.data ?? [];
  const selectedAgent = useMemo(
    () => agentOptions.find((a) => a.agent_id === agentId) ?? null,
    [agentOptions, agentId],
  );

  const progress = useTenantLocationProgress(agentId);
  const list = useTenantLocationCorrections({ agentId, search: debounced, page, pageSize: PAGE_SIZE });

  const rows = list.data?.rows ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const stats = useMemo(() => {
    const t = progress.data?.total_tenants ?? 0;
    const matched = progress.data?.matched ?? 0;
    return { total: t, matched, unmatched: progress.data?.unmatched ?? 0, pct: t > 0 ? Math.round((matched / t) * 100) : 0 };
  }, [progress.data]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
            <MapPin className="h-4 w-4 text-primary" />
            Tenant Location Corrections
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Tenants saved before the approved location list. Once a tenant is matched they leave this page automatically.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Popover open={agentOpen} onOpenChange={setAgentOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={agentOpen}
                  className="w-full justify-between gap-2 sm:max-w-sm"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <User className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate">
                      {selectedAgent
                        ? selectedAgent.agent_name || 'Unnamed agent'
                        : agentId
                          ? 'Selected agent'
                          : 'All agents'}
                    </span>
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-[min(22rem,calc(100vw-2rem))] p-0" align="start">
                <Command shouldFilter={false}>
                  <CommandInput
                    value={agentQuery}
                    onValueChange={setAgentQuery}
                    placeholder="Search agent by name or phone"
                  />
                  <CommandList>
                    {agents.isLoading ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading agents…
                      </div>
                    ) : (
                      <>
                        <CommandEmpty>No agent found</CommandEmpty>
                        <CommandGroup>
                          <CommandItem
                            value="__all__"
                            onSelect={() => {
                              setAgentId(null);
                              setPage(0);
                              setAgentOpen(false);
                            }}
                          >
                            <Check className={agentId ? 'mr-2 h-4 w-4 opacity-0' : 'mr-2 h-4 w-4'} />
                            All agents
                          </CommandItem>
                          {agentOptions.map((a) => (
                            <CommandItem
                              key={a.agent_id}
                              value={a.agent_id}
                              onSelect={() => {
                                setAgentId(a.agent_id);
                                setPage(0);
                                setAgentOpen(false);
                              }}
                            >
                              <Check
                                className={
                                  agentId === a.agent_id ? 'mr-2 h-4 w-4' : 'mr-2 h-4 w-4 opacity-0'
                                }
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-sm">{a.agent_name || 'Unnamed agent'}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">
                                  {a.agent_phone || '—'}
                                </span>
                              </span>
                              <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">
                                {a.unmatched.toLocaleString()} left
                              </Badge>
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </>
                    )}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            {agentId && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full gap-1.5 sm:w-auto"
                onClick={() => {
                  setAgentId(null);
                  setPage(0);
                }}
              >
                <X className="h-3.5 w-3.5" /> Clear agent
              </Button>
            )}
          </div>

          {agentId && (
            <p className="text-xs text-muted-foreground">
              Showing only tenants handled by{' '}
              <span className="font-semibold text-foreground">
                {selectedAgent?.agent_name || 'the selected agent'}
              </span>
              .
            </p>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
            <div className="rounded-xl border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Still to correct</p>
              <p className="mt-0.5 text-xl font-bold">{stats.unmatched.toLocaleString()}</p>
            </div>
            <div className="rounded-xl border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Corrected</p>
              <p className="mt-0.5 text-xl font-bold text-emerald-600">{stats.matched.toLocaleString()}</p>
            </div>
            <div className="col-span-2 sm:col-span-1 rounded-xl border bg-card p-3">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">All tenants</p>
              <p className="mt-0.5 text-xl font-bold">{stats.total.toLocaleString()}</p>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs font-semibold">
              <span>
                {stats.matched.toLocaleString()} of {stats.total.toLocaleString()} corrected
              </span>
              <span className="text-muted-foreground">{stats.pct}%</span>
            </div>
            <Progress value={stats.pct} className="h-2" />
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search tenant, phone, old district or agent"
              className="pl-9"
            />
          </div>

          {list.isLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading tenants…
            </div>
          )}

          {!list.isLoading && rows.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <CheckCircle2 className="h-6 w-6 text-emerald-600" />
              <p className="text-sm font-semibold">
                {debounced ? 'No tenants match that search' : 'Every tenant is on the approved list'}
              </p>
            </div>
          )}

          {rows.length > 0 && (
            <>
              {/* Mobile / tablet cards */}
              <div className="space-y-2 lg:hidden">
                {rows.map((row) => (
                  <div key={row.tenant_id} className="rounded-xl border bg-card p-3 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">{row.tenant_name || 'Unnamed tenant'}</p>
                        {row.tenant_phone && (
                          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
                            <Phone className="h-3 w-3" /> {row.tenant_phone}
                          </p>
                        )}
                      </div>
                      {row.request_status && (
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          {row.request_status.replace(/_/g, ' ')}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground break-words">
                      <span className="font-medium text-foreground">On record: </span>
                      {legacyLocationLabel(row)}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" /> {row.agent_name || 'No agent'}
                        {row.agent_phone ? ` · ${row.agent_phone}` : ''}
                      </span>
                      {row.monthly_rent != null && <span>{formatUGX(row.monthly_rent)}</span>}
                    </div>
                    <Button size="sm" className="w-full gap-1.5" onClick={() => setSelected(row)}>
                      <Pencil className="h-3.5 w-3.5" /> Correct location
                    </Button>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden lg:block overflow-x-auto rounded-xl border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2.5 font-semibold">Tenant</th>
                      <th className="p-2.5 font-semibold">Location on record</th>
                      <th className="p-2.5 font-semibold">Agent</th>
                      <th className="p-2.5 font-semibold">Rent</th>
                      <th className="p-2.5 font-semibold">Status</th>
                      <th className="p-2.5 font-semibold text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.tenant_id} className="border-t hover:bg-accent/30">
                        <td className="p-2.5">
                          <p className="font-medium">{row.tenant_name || 'Unnamed tenant'}</p>
                          <p className="text-[11px] text-muted-foreground">{row.tenant_phone || '—'}</p>
                        </td>
                        <td className="p-2.5 max-w-[22rem] text-muted-foreground">{legacyLocationLabel(row)}</td>
                        <td className="p-2.5">
                          <p>{row.agent_name || 'No agent'}</p>
                          <p className="text-[11px] text-muted-foreground">{row.agent_phone || '—'}</p>
                        </td>
                        <td className="p-2.5 whitespace-nowrap">
                          {row.monthly_rent != null ? formatUGX(row.monthly_rent) : '—'}
                        </td>
                        <td className="p-2.5">
                          {row.request_status ? (
                            <Badge variant="outline" className="text-[10px]">
                              {row.request_status.replace(/_/g, ' ')}
                            </Badge>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="p-2.5 text-right">
                          <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setSelected(row)}>
                            <Pencil className="h-3.5 w-3.5" /> Correct
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-1">
                <p className="text-xs text-muted-foreground">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString()}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={page === 0 || list.isFetching}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Previous
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Page {page + 1} of {pageCount}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    disabled={page + 1 >= pageCount || list.isFetching}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <CorrectTenantLocationDialog
        open={!!selected}
        onOpenChange={(v) => !v && setSelected(null)}
        tenant={
          selected
            ? {
                id: selected.tenant_id,
                name: selected.tenant_name,
                phone: selected.tenant_phone,
                legacyLabel: legacyLocationLabel(selected),
                districtHint: null,
              }
            : null
        }
        onCorrected={() => setSelected(null)}
      />
    </div>
  );
}

export default TenantLocationCorrectionsHub;
