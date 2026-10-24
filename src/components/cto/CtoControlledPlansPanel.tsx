import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, FileDown, Landmark, Loader2, RefreshCw, Settings2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  useCtoControlledPlanCollections,
  useCtoControlledPlanMutations,
  useCtoPlanSearch,
} from '@/hooks/useCtoControlledPlanCollections';
import {
  balanceOf,
  defaultPlanOrder,
  fmtUgx,
  pct,
  recoveredSplit,
  rollUpByAgent,
  type CtoControlledPlan,
} from '@/lib/ctoControlledPlans';
import { generateCtoControlledPlansPdf } from '@/lib/ctoControlledPlansPdf';

type SortKey =
  | 'default' | 'tenantName' | 'agentName' | 'fundedOn' | 'durationDays' | 'given' | 'formulaDue' | 'recovered' | 'pctRecovered'
  | 'principalBack' | 'partnerEarned' | 'agentCommission' | 'platformEarned' | 'daysOverdue' | 'status';

const SPLIT_COLORS: Record<string, string> = {
  principal: 'bg-emerald-500',
  partner: 'bg-violet-500',
  agent: 'bg-amber-500',
  platform: 'bg-sky-500',
};

function sortValue(p: CtoControlledPlan, key: SortKey): string | number {
  switch (key) {
    case 'pctRecovered': return pct(p.recovered, p.formulaDue);
    case 'fundedOn': return p.fundedOn ?? '';
    case 'tenantName': case 'agentName': case 'status': return p[key].toLowerCase();
    case 'default': return 0;
    default: return p[key];
  }
}

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold tabular-nums leading-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function SortHead({ label, k, sort, dir, onSort, className }: { label: string; k: SortKey; sort: SortKey; dir: 'asc' | 'desc'; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort === k;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <TableHead className={className}>
      <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 whitespace-nowrap font-medium hover:text-foreground">
        {label}
        <Icon className={`h-3 w-3 ${active ? 'text-foreground' : 'text-muted-foreground/60'}`} />
      </button>
    </TableHead>
  );
}

export function CtoControlledPlansPanel() {
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useCtoControlledPlanCollections();
  const [manageOpen, setManageOpen] = useState(false);
  const [agentFilter, setAgentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('default');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [pdfBusy, setPdfBusy] = useState(false);

  const plans = data?.plans ?? [];
  const summary = data?.summary;

  const agents = useMemo(() => rollUpByAgent(plans), [plans]);
  const statuses = useMemo(() => [...new Set(plans.map((p) => p.status))].sort(), [plans]);

  const rows = useMemo(() => {
    const filtered = plans.filter(
      (p) => (agentFilter === 'all' || (p.agentId ?? p.agentName) === agentFilter) && (statusFilter === 'all' || p.status === statusFilter),
    );
    if (sort === 'default') return [...filtered].sort(defaultPlanOrder);
    const sign = dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort);
      const bv = sortValue(b, sort);
      return (av < bv ? -1 : av > bv ? 1 : 0) * sign || defaultPlanOrder(a, b);
    });
  }, [plans, agentFilter, statusFilter, sort, dir]);

  const onSort = (k: SortKey) => {
    if (sort === k) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(k); setDir(k === 'tenantName' || k === 'agentName' || k === 'status' ? 'asc' : 'desc'); }
  };

  const handlePdf = async () => {
    if (!summary || !plans.length) { toast.error('Nothing to export yet'); return; }
    setPdfBusy(true);
    try {
      const blob = await generateCtoControlledPlansPdf({ plans, summary });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cto_controlled_rent_plans_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('PDF downloaded');
    } catch (e: any) {
      toast.error('Failed to generate the PDF', { description: e?.message });
    } finally {
      setPdfBusy(false);
    }
  };

  const split = summary ? recoveredSplit(summary) : [];
  const splitTotal = split.reduce((s, x) => s + x.amount, 0);

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between space-y-0">
        <div className="flex items-start gap-3">
          <div className="rounded-xl bg-violet-600 p-2.5 text-white shadow-sm"><Landmark className="h-5 w-5" /></div>
          <div>
            <CardTitle className="text-base sm:text-lg">CTO-Controlled Rent Plans</CardTitle>
            <CardDescription>
              What each Rent Plan was given, what is due and what has come back, split into principal, Partner, agent and platform.
              {dataUpdatedAt ? <span className="ml-1">Updated {format(new Date(dataUpdatedAt), 'HH:mm:ss')}.</span> : null}
            </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} aria-label="Refresh">
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="outline" size="sm" onClick={handlePdf} disabled={pdfBusy || !plans.length}>
            {pdfBusy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <FileDown className="mr-1.5 h-4 w-4" />}
            Download PDF
          </Button>
          <Button size="sm" onClick={() => setManageOpen(true)}>
            <Settings2 className="mr-1.5 h-4 w-4" /> Manage CTO plans
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {isLoading && (
          <div className="space-y-4" aria-busy="true">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)}</div>
            <Skeleton className="h-6 w-full rounded-full" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        )}

        {isError && !isLoading && (
          <div role="alert" className="flex flex-col gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <span>Couldn&apos;t load the CTO-controlled Rent Plans{(error as any)?.message ? `: ${(error as any).message}` : '.'}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
          </div>
        )}

        {!isLoading && !isError && summary && plans.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <p className="font-medium">No Rent Plans are on the CTO-controlled list yet.</p>
            <p className="mt-1 text-sm text-muted-foreground">Add the plans you control and their collections will show here.</p>
            <Button className="mt-3" size="sm" onClick={() => setManageOpen(true)}><Settings2 className="mr-1.5 h-4 w-4" /> Manage CTO plans</Button>
          </div>
        )}

        {!isLoading && !isError && summary && plans.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatTile label="Plans controlled" value={String(summary.plansCount)} />
              <StatTile label="Total given" value={fmtUgx(summary.given)} />
              <StatTile label="Total due" value={fmtUgx(summary.formulaDue)} />
              <StatTile label="Recovered" value={fmtUgx(summary.recovered)} hint={`${pct(summary.recovered, summary.formulaDue)}% of due`} />
              <StatTile label="Principal returned" value={fmtUgx(summary.principalBack)} hint={`${pct(summary.principalBack, summary.given)}% of given`} />
              <StatTile label="Partner earned" value={fmtUgx(summary.partnerEarned)} hint={`Expected ${fmtUgx(summary.expectedPartner)}`} />
              <StatTile label="Agent earned" value={fmtUgx(summary.agentCommission)} hint={`Expected ${fmtUgx(summary.expectedAgent)}`} />
              <StatTile label="Platform earned" value={fmtUgx(summary.platformEarned)} />
            </div>

            {summary.anyMismatch && (
              <div role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                Some Rent Plans have collections that don&apos;t add up to the amount repaid. They are flagged &quot;Counter mismatch&quot; in the table.
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-baseline justify-between text-sm">
                <span className="font-medium">Where the recovered cash went</span>
                <span className="tabular-nums text-muted-foreground">{fmtUgx(splitTotal)}</span>
              </div>
              <div className="flex h-5 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Recovered cash split into principal back, Partner, agent and platform">
                {split.map((s) => (
                  s.amount > 0 && splitTotal > 0 ? (
                    <div key={s.key} className={SPLIT_COLORS[s.key]} style={{ width: `${(s.amount / splitTotal) * 100}%` }} title={`${s.label}: ${fmtUgx(s.amount)}`} />
                  ) : null
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {split.map((s) => (
                  <span key={s.key} className="inline-flex items-center gap-1.5">
                    <span className={`h-2.5 w-2.5 rounded-sm ${SPLIT_COLORS[s.key]}`} />
                    {s.label} <span className="tabular-nums text-muted-foreground">{fmtUgx(s.amount)} ({pct(s.amount, splitTotal)}%)</span>
                  </span>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Select value={agentFilter} onValueChange={setAgentFilter}>
                <SelectTrigger className="h-9 w-[200px]"><SelectValue placeholder="All agents" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All agents</SelectItem>
                  {agents.map((a) => <SelectItem key={a.agentId ?? a.agentName} value={a.agentId ?? a.agentName}>{a.agentName} ({a.plans})</SelectItem>)}
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="h-9 w-[170px]"><SelectValue placeholder="All statuses" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {statuses.map((s) => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                </SelectContent>
              </Select>
              {(agentFilter !== 'all' || statusFilter !== 'all' || sort !== 'default') && (
                <Button variant="ghost" size="sm" onClick={() => { setAgentFilter('all'); setStatusFilter('all'); setSort('default'); }}>Reset</Button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">{rows.length} of {plans.length} Rent Plans</span>
            </div>

            <div className="overflow-x-auto rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortHead label="Tenant" k="tenantName" sort={sort} dir={dir} onSort={onSort} />
                    <SortHead label="Agent" k="agentName" sort={sort} dir={dir} onSort={onSort} />
                    <SortHead label="Funded" k="fundedOn" sort={sort} dir={dir} onSort={onSort} />
                    <SortHead label="Days" k="durationDays" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Given" k="given" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Due" k="formulaDue" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Recovered" k="recovered" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="% recovered" k="pctRecovered" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Principal back" k="principalBack" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Partner" k="partnerEarned" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Agent" k="agentCommission" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Platform" k="platformEarned" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Days overdue" k="daysOverdue" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortHead label="Status" k="status" sort={sort} dir={dir} onSort={onSort} />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => {
                    const overdue = p.daysOverdue > 0;
                    const noPayment = p.collectionCount === 0;
                    return (
                      <TableRow key={p.rentRequestId} className={overdue ? 'bg-destructive/5' : noPayment ? 'bg-amber-500/5' : undefined}>
                        <TableCell className="whitespace-nowrap font-medium">
                          {p.tenantName}
                          {p.counterMismatch && <Badge variant="destructive" className="ml-2 px-1.5 py-0 text-[10px]">Counter mismatch</Badge>}
                          {noPayment && !overdue && <Badge variant="outline" className="ml-2 border-amber-500/50 px-1.5 py-0 text-[10px] text-amber-700">No payment yet</Badge>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{p.agentName}</TableCell>
                        <TableCell className="whitespace-nowrap">{p.fundedOn ? format(new Date(p.fundedOn), 'dd MMM yy') : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{p.durationDays}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.given)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.formulaDue)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.recovered)}</TableCell>
                        <TableCell className="text-right tabular-nums">{pct(p.recovered, p.formulaDue)}%</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.principalBack)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.partnerEarned)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.agentCommission)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(p.platformEarned)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${overdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>{overdue ? p.daysOverdue : '—'}</TableCell>
                        <TableCell><Badge variant="secondary" className="capitalize">{p.status}</Badge></TableCell>
                      </TableRow>
                    );
                  })}
                  {rows.length === 0 && (
                    <TableRow><TableCell colSpan={14} className="py-8 text-center text-muted-foreground">No Rent Plans match these filters.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <div>
              <h3 className="mb-2 text-sm font-semibold">By agent</h3>
              <div className="overflow-x-auto rounded-xl border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Plans</TableHead>
                      <TableHead className="text-right">Recovered</TableHead>
                      <TableHead className="text-right">Agent commission</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {agents.map((a) => (
                      <TableRow key={a.agentId ?? a.agentName}>
                        <TableCell className="font-medium">{a.agentName}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.plans}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(a.recovered)}</TableCell>
                        <TableCell className="whitespace-nowrap text-right tabular-nums">{fmtUgx(a.agentCommission)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </CardContent>

      <ManagePlansDialog open={manageOpen} onOpenChange={setManageOpen} controlled={plans} />
    </Card>
  );
}

function ManagePlansDialog({ open, onOpenChange, controlled }: { open: boolean; onOpenChange: (o: boolean) => void; controlled: CtoControlledPlan[] }) {
  const [term, setTerm] = useState('');
  const [pickedAdd, setPickedAdd] = useState<Set<string>>(new Set());
  const [pickedRemove, setPickedRemove] = useState<Set<string>>(new Set());
  const search = useCtoPlanSearch(term, open);
  const { add, remove } = useCtoControlledPlanMutations();
  const ordered = useMemo(() => [...controlled].sort(defaultPlanOrder), [controlled]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    setter(next);
  };

  const doAdd = async () => {
    try {
      const n = await add.mutateAsync([...pickedAdd]);
      toast.success(`${n} Rent Plan${n === 1 ? '' : 's'} added to the CTO-controlled list`);
      setPickedAdd(new Set());
    } catch (e: any) {
      toast.error('Couldn\'t add the plans', { description: e?.message });
    }
  };
  const doRemove = async () => {
    try {
      const n = await remove.mutateAsync([...pickedRemove]);
      toast.success(`${n} Rent Plan${n === 1 ? '' : 's'} removed from the CTO-controlled list`);
      setPickedRemove(new Set());
    } catch (e: any) {
      toast.error('Couldn\'t remove the plans', { description: e?.message });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Manage CTO plans</DialogTitle>
          <DialogDescription>Choose which Rent Plans count as CTO-controlled. Every change is recorded in the audit log.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="add">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="add">Add plans</TabsTrigger>
            <TabsTrigger value="remove">On the list ({controlled.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="add" className="space-y-3">
            <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search by tenant name, phone or agent name" />
            {search.isFetching && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Searching…</div>}
            {search.isError && <p className="text-sm text-destructive">Search failed. Try again.</p>}
            {term.trim().length >= 2 && !search.isFetching && !search.isError && (search.data?.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">No Rent Plans found.</p>
            )}
            <ul className="divide-y rounded-xl border border-border">
              {(search.data ?? []).map((r) => (
                <li key={r.rentRequestId} className="flex items-center gap-3 p-3 text-sm">
                  <Checkbox
                    checked={r.controlled || pickedAdd.has(r.rentRequestId)}
                    disabled={r.controlled}
                    onCheckedChange={() => toggle(pickedAdd, setPickedAdd, r.rentRequestId)}
                    aria-label={`Select ${r.tenantName}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.tenantName}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {r.agentName} · {fmtUgx(r.rentAmount)} · {r.fundedOn ? format(new Date(r.fundedOn), 'dd MMM yy') : 'not funded'}
                    </div>
                  </div>
                  <Badge variant={r.controlled ? 'default' : 'secondary'} className="capitalize">{r.controlled ? 'On the list' : r.status}</Badge>
                </li>
              ))}
            </ul>
            <Button onClick={doAdd} disabled={pickedAdd.size === 0 || add.isPending}>
              {add.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Add {pickedAdd.size || ''} to the list
            </Button>
          </TabsContent>

          <TabsContent value="remove" className="space-y-3">
            {ordered.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing is on the list.</p>
            ) : (
              <ul className="max-h-[45vh] divide-y overflow-y-auto rounded-xl border border-border">
                {ordered.map((p) => (
                  <li key={p.rentRequestId} className="flex items-center gap-3 p-3 text-sm">
                    <Checkbox
                      checked={pickedRemove.has(p.rentRequestId)}
                      onCheckedChange={() => toggle(pickedRemove, setPickedRemove, p.rentRequestId)}
                      aria-label={`Select ${p.tenantName}`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.tenantName}</div>
                      <div className="truncate text-xs text-muted-foreground">{p.agentName} · given {fmtUgx(p.given)} · recovered {fmtUgx(p.recovered)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Button variant="destructive" onClick={doRemove} disabled={pickedRemove.size === 0 || remove.isPending}>
              {remove.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Remove {pickedRemove.size || ''} from the list
            </Button>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export default CtoControlledPlansPanel;
