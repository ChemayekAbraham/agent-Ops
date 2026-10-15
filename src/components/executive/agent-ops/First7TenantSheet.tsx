import { AlertTriangle, Loader2, Phone, RefreshCw, UserRound } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useNewTenantFirst7Payments } from '@/hooks/useNewTenantFirst7';
import { formatUGX } from '@/lib/rentCalculations';
import { telHref } from '@/lib/awarenessCallLabels';
import { cn } from '@/lib/utils';
import {
  DAY_STATE_LABEL,
  addDays,
  first7ErrorMessage,
  kampalaDateTime,
  paymentMethodLabel,
  type AgentOnTrack,
  type First7Row,
} from '@/lib/newTenantFirst7';
import { CELL_TONE, cellKind, fmtDay, isDueDay, planLabel } from './first7Cells';
import { StatusBadge } from './First7StatusBadge';

interface Props {
  /** the Rent Plan to show; null closes the panel */
  row: First7Row | null;
  /** 1 to 7: show only that day's payments; null = all seven days */
  day: number | null;
  /** the agent's seven-day figures, when known */
  agentStats: AgentOnTrack | null;
  onDayChange: (day: number | null) => void;
  onClose: () => void;
  onFilterAgent: (agentId: string) => void;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-xs text-foreground">{children}</dd>
    </div>
  );
}

/** Side panel for one Rent Plan in the First 7 Days tab: its seven days, the payments behind them, the agent and the phone. Read-only. */
export function First7TenantSheet({ row, day, agentStats, onDayChange, onClose, onFilterAgent }: Props) {
  const { payments, isLoading, error, refetch } = useNewTenantFirst7Payments(row?.rent_request_id ?? null);
  const shown = day === null ? payments : payments.filter((p) => p.day_number === day);
  const shownTotal = shown.reduce((a, p) => a + p.amount, 0);
  const tel = telHref(row?.tenant_phone);
  const total = row?.total_repayment ?? 0;

  return (
    <Sheet open={!!row} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md" aria-describedby="first7-sheet-desc">
        {row && (
          <div className="space-y-4">
            <SheetHeader className="space-y-1 pr-6 text-left">
              <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
                {row.tenant_name ?? 'Tenant'}
                <StatusBadge status={row.row_status} />
              </SheetTitle>
              <SheetDescription id="first7-sheet-desc" className="text-xs">
                Rent Plan · first 7 days after the landlord was paid
              </SheetDescription>
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-x-3 gap-y-3 rounded-xl border border-border bg-card p-3">
              <Fact label="Phone">
                {tel ? (
                  <a href={tel} aria-label={`Call ${row.tenant_name ?? 'the tenant'} on ${row.tenant_phone}`} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                    <Phone className="h-3 w-3" /> {row.tenant_phone}
                  </a>
                ) : (
                  row.tenant_phone ?? '—'
                )}
              </Fact>
              <Fact label="Agent">
                {row.agent_id ? (
                  <button type="button" onClick={() => onFilterAgent(row.agent_id as string)} className="inline-flex items-center gap-1 text-left font-semibold text-primary hover:underline" title="Show only this agent's Rent Plans">
                    <UserRound className="h-3 w-3 shrink-0" /> {row.agent_name ?? 'Agent'}
                  </button>
                ) : (
                  row.agent_name ?? '—'
                )}
                {agentStats && agentStats.pct !== null && (
                  <span className="block text-xs text-muted-foreground">{agentStats.pct}% on track ({agentStats.on_track} of {agentStats.started} Rent Plans)</span>
                )}
              </Fact>
              <Fact label="Landlord paid">{fmtDay(row.landlord_paid_on)}</Fact>
              <Fact label="Day 1">{fmtDay(row.day1)}</Fact>
              <Fact label="Rent Plan">{planLabel(row)}</Fact>
              <Fact label="Total to repay">{total > 0 ? formatUGX(total) : '—'}</Fact>
              <Fact label="Paid in 7 days">{formatUGX(row.paid_7d)}</Fact>
              <Fact label="Due so far">{formatUGX(row.expected_to_date)}</Fact>
            </dl>

            <section aria-label="Seven-day timeline" className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-foreground">7-day timeline</h3>
                {day !== null && (
                  <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => onDayChange(null)}>
                    Show all days
                  </Button>
                )}
              </div>
              <ul className="space-y-1">
                {Array.from({ length: 7 }, (_, i) => {
                  const kind = cellKind(row, i);
                  const paid = row.day_paid[i] ?? 0;
                  const due = row.day_due[i] ?? 0;
                  const selected = day === i + 1;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onDayChange(selected ? null : i + 1)}
                        className={cn(
                          'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                          CELL_TONE[kind],
                          isDueDay(row, i) && 'ring-2 ring-primary',
                          selected && 'outline outline-2 outline-offset-1 outline-foreground/60',
                        )}
                      >
                        <span className="font-semibold">Day {i + 1} · {fmtDay(addDays(row.day1, i))}</span>
                        <span className="text-right font-mono">
                          {DAY_STATE_LABEL[kind]}
                          {(paid > 0 || due > 0) && (
                            <span className="block text-xs opacity-80">{paid > 0 ? `paid ${formatUGX(paid)}` : ''}{paid > 0 && due > 0 ? ' · ' : ''}{due > 0 ? `due ${formatUGX(due)}` : ''}</span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>

            <section aria-label="Payments" className="space-y-1.5">
              <h3 className="text-xs font-bold text-foreground">
                {day === null ? 'Payments in the 7 days' : `Payments on day ${day} · ${fmtDay(addDays(row.day1, day - 1))}`}
              </h3>
              {isLoading ? (
                <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground" aria-busy="true">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading payments…
                </div>
              ) : error ? (
                <div role="alert" className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                  <p className="flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5" /> {first7ErrorMessage(error)}</p>
                  <Button type="button" size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={refetch}><RefreshCw className="h-3 w-3" /> Try again</Button>
                </div>
              ) : shown.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
                  {day === null ? 'No payment was recorded in these 7 days.' : 'No payment was recorded on this day.'}
                </p>
              ) : (
                <>
                  <ul className="divide-y divide-border/50 rounded-lg border border-border">
                    {shown.map((p) => (
                      <li key={p.collection_id} className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs">
                        <div className="min-w-0">
                          <p className="font-mono font-semibold text-foreground">{formatUGX(p.amount)}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {kampalaDateTime(p.collected_at)} · Day {p.day_number}{p.agent_name ? ` · ${p.agent_name}` : ''}
                          </p>
                        </div>
                        <Badge variant="outline" className="shrink-0 text-xs">{paymentMethodLabel(p.payment_method, p.collection_channel)}</Badge>
                      </li>
                    ))}
                  </ul>
                  <p className="text-right text-xs text-muted-foreground">
                    {shown.length} {shown.length === 1 ? 'payment' : 'payments'} · {formatUGX(shownTotal)}
                  </p>
                </>
              )}
            </section>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
