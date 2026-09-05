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
  };
  rows: TppoPlanDetailRow[];
  generated_at: string;
}

const PAGE = 50;
const moneyCell = 'text-right tabular-nums';

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
  const [agentFilter, setAgentFilter] = useState<string>('all');

  const { data, isPending, isError, error } = useQuery({
    queryKey: ['tppo-plan-detail', granularity, anchor],
    staleTime: 60_000,
    queryFn: async (): Promise<TppoPlanDetailReport> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_period_plan_detail', {
        p_granularity: granularity,
        p_anchor: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as TppoPlanDetailReport;
    },
  });

  // Promissory notes attached to individual rent plans, so each plan's own note
  // shows inline on its row next to the arrears figure.
  type PlanNote = {
    partner: string;
    amount: number;
    taken: string | null;
    promised: string | null;
    followUp: string | null;
    intentStatus: string | null;
  };
  const { data: notesByPlan } = useQuery({
    queryKey: ['tppo-plan-detail-promissory-notes-by-plan'],
    staleTime: 300_000,
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
    }),
    { plans: 0, scheduled: 0, arrears: 0, planTotal: 0, repaid: 0 },
  );

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
              className="flex items-center gap-1.5 text-left touch-manipulation"
              aria-expanded={!collapsed}
            >
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`}
              />
              <h3 className="text-sm font-semibold text-foreground">
                {`Scheduled ${granularity === 'day' ? 'today' : 'this period'} — ${formatUGX(
                  data.totals.scheduled_total,
                )}`}
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
                disabled={isPending || rows.length === 0}
                onClick={() => downloadTppoPlanDetailPdf(data)}
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
            Every plan whose agreed schedule falls due in this period. Plans past their agreed end
            date schedule nothing and are not listed here; their balances sit in opening arrears.
          </p>

          <Table>
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
                <TableHead>Promissory notes</TableHead>
                <TableHead className="text-right">Daily amount</TableHead>
                <TableHead className="text-right">Scheduled</TableHead>
                <TableHead className="text-right">Arrears</TableHead>
                <TableHead className="text-right">Plan total</TableHead>
                <TableHead className="text-right">Repaid</TableHead>
                <TableHead>Term start</TableHead>
                <TableHead>Obligation end</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((row, index) => (
                <TableRow key={row.rent_request_id}>
                  <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                  <TableCell>{row.tenant_name}</TableCell>
                  <TableCell>{row.agent_name}</TableCell>
                  <TableCell className="text-xs">
                    {(() => {
                      const planNotes = notesByPlan?.[row.rent_request_id];
                      if (!planNotes?.length) return <span className="text-muted-foreground">—</span>;
                      const extra = planNotes.length - 1;
                      const n = planNotes[0];
                      return (
                        <div className="leading-tight">
                          <span className="font-medium">{n.partner}</span>
                          <span className="ml-1 tabular-nums text-muted-foreground">{formatUGX(n.amount)}</span>
                          <div className="text-[10px] text-muted-foreground">
                            {`Taken ${n.taken ?? '—'} · Promised ${n.promised ?? '—'}`}
                            {n.followUp ? ` · ${n.followUp.replace(/_/g, ' ')}` : ''}
                          </div>
                          {extra > 0 && (
                            <div className="text-[10px] text-muted-foreground">{`+${extra} more note${extra === 1 ? '' : 's'}`}</div>
                          )}
                        </div>
                      );
                    })()}
                  </TableCell>

                  <TableCell className={moneyCell}>{formatUGX(row.daily_amount)}</TableCell>
                  <TableCell className={moneyCell}>{formatUGX(row.scheduled_in_period)}</TableCell>
                  <TableCell className={moneyCell}>
                    <button
                      type="button"
                      onClick={() => setSelected({ id: row.rent_request_id, name: row.tenant_name })}
                      className="underline decoration-dotted underline-offset-2 hover:decoration-solid touch-manipulation"
                      title="See where this arrears comes from"
                    >
                      {row.arrears > 0 ? (
                        <span className="text-destructive">{formatUGX(row.arrears)}</span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </button>
                  </TableCell>
                  <TableCell className={moneyCell}>{formatUGX(row.plan_total)}</TableCell>
                  <TableCell className={moneyCell}>{formatUGX(row.repaid)}</TableCell>
                  <TableCell>{row.term_start}</TableCell>
                  <TableCell>{row.obligation_end}</TableCell>
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
                <TableCell />
                <TableCell className={`${moneyCell} font-semibold`}>
                  {formatUGX(shownTotals.scheduled)}
                </TableCell>
                <TableCell className={`${moneyCell} font-semibold ${shownTotals.arrears > 0 ? 'text-destructive' : ''}`}>
                  {formatUGX(shownTotals.arrears)}
                </TableCell>
                <TableCell className={`${moneyCell} font-semibold`}>
                  {formatUGX(shownTotals.planTotal)}
                </TableCell>
                <TableCell className={`${moneyCell} font-semibold`}>
                  {formatUGX(shownTotals.repaid)}
                </TableCell>
                <TableCell />
                <TableCell />
              </TableRow>
            </TableFooter>
          </Table>

          {remaining > 0 && (
            <div className="mt-3 flex justify-center">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShown((s) => s + PAGE)}
              >
                {`Load more · ${remaining} remaining`}
              </Button>
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
