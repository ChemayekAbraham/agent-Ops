import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { downloadTppoPlanDetailPdf } from '@/lib/tppoPlanDetailPdf';
import { TppoPlanArrearsDialog } from './TppoPlanArrearsDialog';

interface TppoPlanDetailRow {
  rent_request_id: string;
  tenant_name: string;
  agent_name: string;
  daily_amount: number;
  scheduled_in_period: number;
  arrears: number;
  plan_total: number;
  repaid: number;
  term_start: string;
  obligation_end: string;
  paid_in_period: number;
  scheduled_outstanding: number;
  overpaid_in_period: number;
}

interface TppoPlanDetailArrearsPayment {
  rent_request_id: string;
  tenant_name: string;
  agent_name: string;
  paid_in_period: number;
  arrears: number;
  outstanding: number;
  plan_total: number;
  repaid: number;
  daily_amount: number;
  term_start: string;
  obligation_end: string;
  days_past_term: number;
}

interface TppoPlanDetailReport {
  granularity: string;
  period_start: string;
  period_end: string;
  scheduled_through: string;
  period_open: boolean;
  schedule_basis: 'pinned' | 'live';
  timezone: string;
  totals: {
    plans: number;
    scheduled_total: number;
    arrears_total: number;
    plans_in_arrears: number;
    paid_total: number;
    outstanding_total: number;
    overpaid_total: number;
    plans_paid: number;
    arrears_paid_total: number;
    arrears_paid_plans: number;
    arrears_paid_agents: number;
    collected_total: number;
  };
  rows: TppoPlanDetailRow[];
  paid_outside_schedule: number;
  arrears_payments: TppoPlanDetailArrearsPayment[];
  generated_at: string;
}

const PAGE = 50;
const moneyCell = 'text-right tabular-nums font-mono';

export function TppoPlanDetailTable({
  granularity,
  anchor,
}: {
  granularity: string;
  anchor: string;
}) {
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [arrearsCollapsed, setArrearsCollapsed] = useState(true);
  const [arrearsShown, setArrearsShown] = useState(PAGE);
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['tppo-plan-detail', granularity, anchor],
    staleTime: 15_000,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<TppoPlanDetailReport> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_period_plan_detail', {
        p_granularity: granularity,
        p_anchor: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as TppoPlanDetailReport;
    },
  });

  // Promissory notes column is hidden for now. The query is retained and disabled
  // so the column can be restored by removing `enabled: false` and re-adding its
  // header and body cells. Do not delete this block.
  type PlanNote = {
    partner: string;
    amount: number;
    taken: string | null;
    promised: string | null;
    followUp: string | null;
    intentStatus: string | null;
  };
  const { data: _notesByPlan } = useQuery({
    queryKey: ['tppo-plan-detail-promissory-notes-by-plan'],
    staleTime: 300_000,
    enabled: false,

    queryFn: async (): Promise<Record<string, PlanNote[]>> => {
      const { data: intents, error: intentError } = await supabase
        .from('promissory_note_plan_intents')
        .select('note_id, rent_request_id, amount, status')
        .order('created_at', { ascending: false })
        .limit(2000);
      if (intentError) throw intentError;
      const list = (intents ?? []).filter((i) => i.rent_request_id && i.note_id);
      if (list.length === 0) return {};
      const noteIds = Array.from(new Set(list.map((i) => i.note_id as string)));
      const { data: notes, error: notesError } = await supabase
        .from('promissory_notes')
        .select('id, partner_name, amount, recorded_on, created_at, fulfilment_due_on, follow_up_status, status')
        .in('id', noteIds);
      if (notesError) throw notesError;
      const noteById = new Map((notes ?? []).map((n) => [n.id as string, n]));
      const out: Record<string, PlanNote[]> = {};
      for (const i of list) {
        const n = noteById.get(i.note_id as string);
        if (!n) continue;
        const planId = i.rent_request_id as string;
        (out[planId] ??= []).push({
          partner: (n.partner_name as string | null) ?? 'Partner',
          amount: Number(i.amount ?? n.amount ?? 0),
          taken: ((n.recorded_on as string | null) ?? (n.created_at as string | null))?.slice(0, 10) ?? null,
          promised: (n.fulfilment_due_on as string | null) ?? null,
          followUp: (n.follow_up_status as string | null) ?? null,
          intentStatus: (i.status as string | null) ?? null,
        });
      }
      return out;
    },
  });


  const rows = data?.rows ?? [];
  const agentNames = Array.from(new Set(rows.map((r) => r.agent_name))).sort((a, b) =>
    a.localeCompare(b),
  );
  const filteredRows =
    agentFilter === 'all' ? rows : rows.filter((r) => r.agent_name === agentFilter);
  const visible = filteredRows.slice(0, shown);
  const remaining = filteredRows.length - visible.length;
  // Footer sums reflect only the rows currently displayed (agent filter applied).
  const shownTotals = filteredRows.reduce(
    (acc, r) => ({
      plans: acc.plans + 1,
      scheduled: acc.scheduled + r.scheduled_in_period,
      arrears: acc.arrears + r.arrears,
      planTotal: acc.planTotal + r.plan_total,
      repaid: acc.repaid + r.repaid,
      paid: acc.paid + r.paid_in_period,
      outstanding: acc.outstanding + r.scheduled_outstanding,
    }),
    { plans: 0, scheduled: 0, arrears: 0, planTotal: 0, repaid: 0, paid: 0, outstanding: 0 },
  );

  const arrearsRows = data?.arrears_payments ?? [];
  const visibleArrears = arrearsRows.slice(0, arrearsShown);
  const arrearsRemaining = arrearsRows.length - visibleArrears.length;

  return (
    <section className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      {isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive">
          Could not load the plan detail: {(error as Error)?.message ?? 'unknown error'}
        </p>
      ) : data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setCollapsed((c) => !c)}
              className="flex min-h-11 items-center gap-1.5 text-left touch-manipulation"
              aria-expanded={!collapsed}
            >
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`}
              />
              <h3 className="text-sm font-semibold text-foreground">
                {`Scheduled ${granularity === 'day' ? 'today' : 'this period'} — `}
                <span className="tabular-nums font-mono">{formatUGX(data.totals.scheduled_total)}</span>
              </h3>
            </button>
            <div className="flex items-center gap-2">
              <Badge variant="outline">
                {data.schedule_basis === 'pinned' ? 'Fixed for the day' : 'Live'}
              </Badge>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isPending || filteredRows.length === 0}
                onClick={() =>
                  agentFilter === 'all'
                    ? downloadTppoPlanDetailPdf(data)
                    : downloadTppoPlanDetailPdf(data, {
                        agentName: agentFilter,
                        rows: filteredRows,
                        totals: {
                          plans: shownTotals.plans,
                          scheduled_total: shownTotals.scheduled,
                          arrears_total: shownTotals.arrears,
                          plans_in_arrears: filteredRows.filter((r) => r.arrears > 0).length,
                          paid_total: shownTotals.paid,
                          outstanding_total: shownTotals.outstanding,
                        },
                      })
                }
              >
                Download PDF
              </Button>
            </div>
          </div>
          {!collapsed && (
          <>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {`${data.period_start} to ${data.period_end} · Africa/Kampala`}
            {data.period_open && ` · counted through ${data.scheduled_through} — period still open`}
          </p>

          <p className="mt-3 text-[11px] text-muted-foreground">
            Every plan whose agreed schedule falls due in this period. Scheduled is the contractual
            amount and does not shrink when a tenant pays — Paid and Still due show that. Anything
            still due when the day closes becomes arrears. Plans past their agreed end date schedule
            nothing and are not listed here.
          </p>

          <div className="hidden sm:block">
          <Table className="w-full table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">#</TableHead>
                <TableHead>Tenant</TableHead>
                <TableHead>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={agentFilter}
                      onChange={(e) => {
                        setAgentFilter(e.target.value);
                        setShown(PAGE);
                      }}
                      className="w-full max-w-[160px] cursor-pointer rounded-md border border-transparent bg-transparent text-xs font-medium text-muted-foreground hover:border-border focus:outline-none focus:ring-1 focus:ring-ring"
                      aria-label="Filter by agent"
                    >
                      <option value="all">Agent (All)</option>
                      {agentNames.map((name) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                    {agentFilter === 'all' && (
                      <span className="text-[10px] text-muted-foreground">
                        {agentNames.length}
                      </span>
                    )}
                  </div>
                </TableHead>
                <TableHead className="text-right">Daily</TableHead>
                <TableHead className="text-right">Scheduled</TableHead>
                <TableHead className="text-right">Paid</TableHead>
                <TableHead className="text-right">Still due</TableHead>
                <TableHead className="text-right">Arrears</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row, index) => (
                <TableRow key={row.rent_request_id}>
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="truncate" title={row.tenant_name}>{row.tenant_name}</TableCell>
                  <TableCell className="truncate" title={row.agent_name}>{row.agent_name}</TableCell>
                  <TableCell className={moneyCell}>{formatUGX(row.daily_amount)}</TableCell>
                  <TableCell className={moneyCell}>{formatUGX(row.scheduled_in_period)}</TableCell>
                  <TableCell className={moneyCell}>
                    {row.paid_in_period > 0 ? (
                      <span className="inline-flex items-center justify-end gap-1">
                        <span className={row.overpaid_in_period > 0 ? 'text-emerald-600' : ''}>
                          {formatUGX(row.paid_in_period)}
                        </span>
                        {row.overpaid_in_period > 0 && (
                          <Badge variant="outline" className="text-[10px] font-mono">
                            {`+${formatUGX(row.overpaid_in_period)} over`}
                          </Badge>
                        )}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className={moneyCell}>
                    {row.scheduled_outstanding > 0 ? (
                      <span className="text-foreground">{formatUGX(row.scheduled_outstanding)}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className={moneyCell}>
                    <button
                      type="button"
                      onClick={() => setSelected({ id: row.rent_request_id, name: row.tenant_name })}
                      className="min-h-11 underline decoration-dotted underline-offset-2 hover:decoration-solid touch-manipulation"
                      title="See where this arrears comes from"
                    >
                      {row.arrears > 0 ? (
                        <span className="text-destructive">{formatUGX(row.arrears)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell />
                <TableCell className="font-semibold">
                  {agentFilter === 'all' ? 'TOTAL' : `TOTAL · ${agentFilter}`}
                </TableCell>
                <TableCell>{`${shownTotals.plans} plans`}</TableCell>
                <TableCell />
                <TableCell className={`${moneyCell} font-semibold`}>
                  {formatUGX(shownTotals.scheduled)}
                </TableCell>
                <TableCell className={`${moneyCell} font-semibold`}>
                  {formatUGX(shownTotals.paid)}
                </TableCell>
                <TableCell className={`${moneyCell} font-semibold`}>
                  {formatUGX(shownTotals.outstanding)}
                </TableCell>
                <TableCell className={`${moneyCell} font-semibold ${shownTotals.arrears > 0 ? 'text-destructive' : ''}`}>
                  {formatUGX(shownTotals.arrears)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {visible.map((row, index) => (
              <div key={row.rent_request_id} className="rounded-md border p-3">
                <p className="text-[11px] text-muted-foreground">{index + 1}</p>
                <p className="text-sm font-medium">{row.tenant_name}</p>
                <p className="text-[11px] text-muted-foreground">{`via ${row.agent_name}`}</p>
                <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Scheduled</p>
                    <p className="text-sm tabular-nums font-mono">{formatUGX(row.scheduled_in_period)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Paid</p>
                    <p className="text-sm tabular-nums font-mono">
                      {row.paid_in_period > 0 ? (
                        <span className="inline-flex flex-wrap items-center gap-1">
                          <span className={row.overpaid_in_period > 0 ? 'text-emerald-600' : ''}>
                            {formatUGX(row.paid_in_period)}
                          </span>
                          {row.overpaid_in_period > 0 && (
                            <Badge variant="outline" className="text-[10px] font-mono">
                              {`+${formatUGX(row.overpaid_in_period)} over`}
                            </Badge>
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Still due</p>
                    <p className="text-sm tabular-nums font-mono">
                      {row.scheduled_outstanding > 0 ? (
                        <span className="text-foreground">{formatUGX(row.scheduled_outstanding)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Arrears</p>
                    <p className="text-sm tabular-nums font-mono">
                      <button
                        type="button"
                        onClick={() => setSelected({ id: row.rent_request_id, name: row.tenant_name })}
                        className="min-h-11 underline decoration-dotted underline-offset-2 hover:decoration-solid touch-manipulation"
                        title="See where this arrears comes from"
                      >
                        {row.arrears > 0 ? (
                          <span className="text-destructive">{formatUGX(row.arrears)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </button>
                    </p>
                  </div>
                </div>
              </div>
            ))}
            <div className="sm:hidden rounded-md border p-3">
              <p className="text-sm font-semibold">
                {agentFilter === 'all' ? 'TOTAL' : `TOTAL · ${agentFilter}`}
              </p>
              <p className="text-[11px] text-muted-foreground">{`${shownTotals.plans} plans`}</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2">
                <div>
                  <p className="text-[11px] text-muted-foreground">Scheduled</p>
                  <p className="text-sm font-semibold tabular-nums font-mono">{formatUGX(shownTotals.scheduled)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Paid</p>
                  <p className="text-sm font-semibold tabular-nums font-mono">{formatUGX(shownTotals.paid)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Still due</p>
                  <p className="text-sm font-semibold tabular-nums font-mono">{formatUGX(shownTotals.outstanding)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-muted-foreground">Arrears</p>
                  <p className={`text-sm font-semibold tabular-nums font-mono ${shownTotals.arrears > 0 ? 'text-destructive' : ''}`}>
                    {formatUGX(shownTotals.arrears)}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">
            {`${agentFilter === 'all' ? '' : 'Across the whole period: '}${data.totals.plans_paid} of ${data.totals.plans} plans have paid ${
              data.granularity === 'day' ? 'today' : 'in this period'
            } · `}
            <span className="tabular-nums font-mono">{formatUGX(data.totals.paid_total)}</span>
            {` received against `}
            <span className="tabular-nums font-mono">{formatUGX(data.totals.scheduled_total)}</span>
            {` scheduled · `}
            <span className="tabular-nums font-mono">{formatUGX(data.totals.outstanding_total)}</span>
            {` still due.`}
          </p>
          {data.paid_outside_schedule > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {`A further `}
              <span className="tabular-nums font-mono">{formatUGX(data.paid_outside_schedule)}</span>
              {` was received from tenants with nothing scheduled in this period — payments against past arrears. Those plans are not listed above.`}
            </p>
          )}

          {remaining > 0 && (
            <div className="mt-3 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-11"
                onClick={() => setShown((s) => s + PAGE)}
              >
                {`Load more · ${remaining} remaining`}
              </Button>
            </div>
          )}

          <div className="mt-2">
            <p className="text-sm font-medium">
              {`Total collected ${granularity === 'day' ? 'today' : 'this period'} — `}
              <span className="tabular-nums font-mono">{formatUGX(data.totals.collected_total)}</span>
            </p>
            <p className="text-[11px] text-muted-foreground">
              <span className="tabular-nums font-mono">{formatUGX(data.totals.paid_total)}</span>
              {` against ${granularity === 'day' ? "today's" : "this period's"} schedule · `}
              <span className="tabular-nums font-mono">{formatUGX(data.totals.arrears_paid_total)}</span>
              {` against past arrears`}
            </p>
          </div>

          {arrearsRows.length > 0 && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => setArrearsCollapsed((c) => !c)}
                className="flex min-h-11 items-center gap-1.5 text-left touch-manipulation"
                aria-expanded={!arrearsCollapsed}
              >
                <ChevronDown
                  className={`h-4 w-4 text-muted-foreground transition-transform ${arrearsCollapsed ? '-rotate-90' : ''}`}
                />
                <div>
                  <h3 className="text-sm font-semibold">
                    {`Arrears settled ${granularity === 'day' ? 'today' : 'this period'} — `}
                    <span className="tabular-nums font-mono">{formatUGX(data.totals.arrears_paid_total)}</span>
                  </h3>
                  <p className="text-[11px] text-muted-foreground">
                    {`${data.totals.arrears_paid_plans} tenants · ${data.totals.arrears_paid_agents} agents · these plans had nothing scheduled, so the money went straight against what they already owed`}
                  </p>
                </div>
              </button>

              {!arrearsCollapsed && (
                <>
                  <p className="mt-2 mb-1 text-[11px] text-muted-foreground">
                    These tenants are past their agreed end date or otherwise had no instalment falling due, so nothing appears for them in the schedule above. Every shilling here reduces the arrears balance the moment it is recorded.
                  </p>

                  <div className="hidden sm:block">
                  <Table className="w-full table-fixed">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Tenant</TableHead>
                        <TableHead>Agent</TableHead>
                        <TableHead className="text-right">Paid</TableHead>
                        <TableHead className="text-right">Arrears now</TableHead>
                        <TableHead className="text-right">Outstanding</TableHead>
                        <TableHead className="text-right">Days past</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {visibleArrears.map((row, index) => (
                        <TableRow key={row.rent_request_id}>
                          <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                          <TableCell className="truncate" title={row.tenant_name}>
                            <button
                              type="button"
                              onClick={() => setSelected({ id: row.rent_request_id, name: row.tenant_name })}
                              className="min-h-11 underline decoration-dotted underline-offset-2 hover:decoration-solid touch-manipulation"
                              title="See where this arrears comes from"
                            >
                              {row.tenant_name}
                            </button>
                          </TableCell>
                          <TableCell className="truncate" title={row.agent_name}>{row.agent_name}</TableCell>
                          <TableCell className={`${moneyCell} text-emerald-600`}>
                            {formatUGX(row.paid_in_period)}
                          </TableCell>
                          <TableCell className={moneyCell}>
                            {row.arrears > 0 ? (
                              <span className="text-destructive">{formatUGX(row.arrears)}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className={moneyCell}>{formatUGX(row.outstanding)}</TableCell>
                          <TableCell className={moneyCell}>{row.days_past_term}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter>
                      <TableRow>
                        <TableCell />
                        <TableCell className="font-semibold">TOTAL</TableCell>
                        <TableCell>{`${data.totals.arrears_paid_plans} tenants`}</TableCell>
                        <TableCell className={`${moneyCell} font-semibold`}>
                          {formatUGX(data.totals.arrears_paid_total)}
                        </TableCell>
                        <TableCell />
                        <TableCell />
                        <TableCell />
                      </TableRow>
                    </TableFooter>
                  </Table>
                  </div>

                  <div className="sm:hidden space-y-2">
                    {visibleArrears.map((row, index) => (
                      <div key={row.rent_request_id} className="rounded-md border p-3">
                        <p className="text-[11px] text-muted-foreground">{index + 1}</p>
                        <button
                          type="button"
                          onClick={() => setSelected({ id: row.rent_request_id, name: row.tenant_name })}
                          className="min-h-11 text-sm font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid touch-manipulation"
                          title="See where this arrears comes from"
                        >
                          {row.tenant_name}
                        </button>
                        <p className="text-[11px] text-muted-foreground">{`via ${row.agent_name}`}</p>
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2">
                          <div>
                            <p className="text-[11px] text-muted-foreground">Paid</p>
                            <p className="text-sm tabular-nums font-mono text-emerald-600">{formatUGX(row.paid_in_period)}</p>
                          </div>
                          <div>
                            <p className="text-[11px] text-muted-foreground">Arrears now</p>
                            <p className="text-sm tabular-nums font-mono">
                              {row.arrears > 0 ? (
                                <span className="text-destructive">{formatUGX(row.arrears)}</span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </p>
                          </div>
                          <div>
                            <p className="text-[11px] text-muted-foreground">Outstanding</p>
                            <p className="text-sm tabular-nums font-mono">{formatUGX(row.outstanding)}</p>
                          </div>
                          <div>
                            <p className="text-[11px] text-muted-foreground">Days past</p>
                            <p className="text-sm tabular-nums font-mono">{row.days_past_term}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="sm:hidden rounded-md border p-3">
                      <p className="text-sm font-semibold">TOTAL</p>
                      <p className="text-[11px] text-muted-foreground">{`${data.totals.arrears_paid_plans} tenants`}</p>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2">
                        <div>
                          <p className="text-[11px] text-muted-foreground">Paid</p>
                          <p className="text-sm font-semibold tabular-nums font-mono">
                            {formatUGX(data.totals.arrears_paid_total)}
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>

                  {arrearsRemaining > 0 && (
                    <div className="mt-3 flex justify-center">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="min-h-11"
                        onClick={() => setArrearsShown((s) => s + PAGE)}
                      >
                        {`Load more · ${arrearsRemaining} remaining`}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          </>
          )}
        </>
      ) : null}

      <TppoPlanArrearsDialog
        rentRequestId={selected?.id ?? null}
        tenantName={selected?.name}
        onClose={() => setSelected(null)}
      />
    </section>
  );
}

export default TppoPlanDetailTable;
