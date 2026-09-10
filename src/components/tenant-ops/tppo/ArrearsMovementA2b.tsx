import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowRight, ArrowUp, ChevronDown, Minus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';

interface ArrearsMovementPeriod {
  period_index: number;
  period_start: string;
  period_end: string;
  counted_through: string;
  still_counting: boolean;
  label: string;
  opening_arrears: number;
  accrued: number;
  prepaid_credit_absorbed: number;
  cleared_by_payment: number;
  closing_arrears: number;
  net_added_to_arrears: number;
  collected_in_period: number;
  paid_ahead_new: number;
  identity_residual: number;
  plans_owing_open: number;
  plans_owing_close: number;
  newly_in_arrears: number;
  fully_cleared: number;
}

interface ArrearsMovementPayload {
  granularity: string;
  anchor: string;
  today: string;
  timezone: string;
  generated_at: string;
  periods: ArrearsMovementPeriod[];
}

interface ArrearsMovementA2bProps {
  granularity: string;
  anchor: string;
}

const money = (value?: number | null) =>
  value === null || value === undefined ? '—' : formatUGX(value);

function signedMoney(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatUGX(Math.abs(value))}`;
}

function signedPct(value?: number | null): string {
  if (value === null || value === undefined) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(1)}%`;
}

function netClass(value?: number | null): string {
  if (value === null || value === undefined) return '';
  return value > 0 ? 'text-destructive' : value < 0 ? 'text-emerald-600' : '';
}

export function ArrearsMovementA2b({ granularity, anchor }: ArrearsMovementA2bProps) {
  const [open, setOpen] = useState(true);

  const { data, isPending, error } = useQuery({
    queryKey: ['tppo-arrears-movement', granularity, anchor],
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<ArrearsMovementPayload> => {
      const { data: rpcData, error: rpcError } = await supabase.rpc('tppo_arrears_movement', {
        p_granularity: granularity,
        p_anchor: anchor,
      });
      if (rpcError) throw rpcError;
      return (rpcData ?? {}) as unknown as ArrearsMovementPayload;
    },
  });

  const periods = [...(data?.periods ?? [])].sort((a, b) => a.period_index - b.period_index);
  const current = periods.find((p) => p.period_index === 2) ?? periods[periods.length - 1];

  return (
    <section
      aria-label="A2b arrears movement"
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex min-h-11 w-full items-start justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="flex flex-wrap items-baseline gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Arrears movement
            </span>
            <span className="text-xs text-muted-foreground">—</span>
            <span className="text-sm font-bold text-foreground tabular-nums font-mono">
              {isPending || !current ? '…' : money(current.closing_arrears)}
            </span>
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {isPending || !current ? (
              'how the balance owed moved, period by period'
            ) : (
              <>
                owed now ·{' '}
                <span className={`tabular-nums font-mono ${netClass(current.net_added_to_arrears)}`}>
                  {signedMoney(current.net_added_to_arrears)}
                </span>{' '}
                this {granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month'} ·{' '}
                <span className="tabular-nums font-mono">{money(current.cleared_by_payment)}</span> cleared
              </>
            )}
          </span>
        </span>
        <ChevronDown
          className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="mt-4">
          {error ? (
            <p className="text-sm text-destructive">{(error as Error).message}</p>
          ) : isPending ? (
            <p className="text-sm text-muted-foreground">Loading arrears movement…</p>
          ) : (
            <>
              {/* Desktop */}
              <div className="hidden sm:block">
                <table className="w-full table-fixed text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th scope="col" className="py-2 pr-3 font-medium">Period</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Opening</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Accrued</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Credit used</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Cleared</th>
                      <th scope="col" className="py-2 pr-3 text-right font-medium">Closing</th>
                      <th scope="col" className="py-2 text-right font-medium">Net change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {periods.map((p) => (
                      <tr key={p.period_index} className="border-b border-border/60 align-top">
                        <td className="py-2 pr-3">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium text-foreground">{p.label}</span>
                            {p.still_counting && (
                              <Badge variant="outline" className="text-[10px] font-medium">
                                still counting
                              </Badge>
                            )}
                            {p.identity_residual !== 0 && (
                              <Badge variant="destructive" className="text-[10px] font-medium">
                                does not balance
                              </Badge>
                            )}
                          </span>
                          {p.counted_through !== p.period_end && (
                            <span className="mt-0.5 block text-[11px] text-muted-foreground">
                              counted through {p.counted_through}
                            </span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(p.opening_arrears)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(p.accrued)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(p.prepaid_credit_absorbed)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-mono text-emerald-600">{money(p.cleared_by_payment)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(p.closing_arrears)}</td>
                        <td className={`py-2 text-right tabular-nums font-mono ${netClass(p.net_added_to_arrears)}`}>
                          {signedMoney(p.net_added_to_arrears)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Mobile */}
              <div className="sm:hidden space-y-2">
                {periods.map((p) => (
                  <div key={p.period_index} className="rounded-md border p-3">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
                      <span>{p.label}</span>
                      {p.still_counting && (
                        <Badge variant="outline" className="text-[10px] font-medium">
                          still counting
                        </Badge>
                      )}
                      {p.identity_residual !== 0 && (
                        <Badge variant="destructive" className="text-[10px] font-medium">
                          does not balance
                        </Badge>
                      )}
                    </p>
                    {p.counted_through !== p.period_end && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        counted through {p.counted_through}
                      </p>
                    )}
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 mt-2">
                      <div>
                        <p className="text-[11px] text-muted-foreground">Opening</p>
                        <p className="text-sm tabular-nums font-mono">{money(p.opening_arrears)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Accrued</p>
                        <p className="text-sm tabular-nums font-mono">{money(p.accrued)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Credit used</p>
                        <p className="text-sm tabular-nums font-mono">{money(p.prepaid_credit_absorbed)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Cleared</p>
                        <p className="text-sm tabular-nums font-mono text-emerald-600">{money(p.cleared_by_payment)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Closing</p>
                        <p className="text-sm tabular-nums font-mono">{money(p.closing_arrears)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Net change</p>
                        <p className={`text-sm tabular-nums font-mono ${netClass(p.net_added_to_arrears)}`}>
                          {signedMoney(p.net_added_to_arrears)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Variance on prior period — arrears only, same shape as A2 */}
              {(() => {
                const earlier = periods.find((p) => p.period_index === 0) ?? null;
                const prior = periods.find((p) => p.period_index === 1) ?? null;
                const cur = periods.find((p) => p.period_index === 2) ?? null;
                if (!earlier || !prior || !cur) return null;

                const pctChange = (from: number, to: number): number | null =>
                  from === 0 ? null : ((to - from) / Math.abs(from)) * 100;

                const headlinePct = pctChange(prior.closing_arrears, cur.closing_arrears);
                const dir =
                  headlinePct === null ? 'none' : headlinePct > 0 ? 'up' : headlinePct < 0 ? 'down' : 'flat';
                const DirIcon = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus;
                // Arrears going up is bad, so the colours are the reverse of a rate.
                const dirClass =
                  dir === 'up'
                    ? 'text-destructive'
                    : dir === 'down'
                      ? 'text-emerald-600'
                      : 'text-muted-foreground';
                const dirLabel =
                  dir === 'up'
                    ? 'more owed than the prior period'
                    : dir === 'down'
                      ? 'less owed than the prior period'
                      : dir === 'flat'
                        ? 'unchanged on the prior period'
                        : 'no comparison available';

                const vRows = [earlier, prior, cur].map((p) => ({
                  key: p.period_index,
                  label: p.label,
                  opening: p.opening_arrears,
                  closing: p.closing_arrears,
                  net: p.net_added_to_arrears,
                  tenants: p.plans_owing_close,
                  current: p.period_index === 2,
                  stillCounting: p.still_counting,
                }));

                const openingDelta = cur.opening_arrears - prior.opening_arrears;
                const closingDelta = cur.closing_arrears - prior.closing_arrears;
                const netDelta = cur.net_added_to_arrears - prior.net_added_to_arrears;
                const tenantsDelta = cur.plans_owing_close - prior.plans_owing_close;

                return (
                  <section
                    aria-label="Arrears variance on prior period"
                    className="mt-4 rounded-md border border-border p-3"
                  >
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Variance on prior period
                    </h4>

                    <div className={`mt-2 flex flex-wrap items-center gap-2 ${dirClass}`}>
                      <DirIcon className="h-5 w-5 shrink-0" aria-hidden="true" />
                      <span className="text-xl font-semibold tabular-nums font-mono">{signedPct(headlinePct)}</span>
                      <span className="text-sm font-medium">{dirLabel}</span>
                    </div>

                    <div className="mt-3 space-y-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm text-foreground">
                        <span>{prior.label}</span>
                        <span className="tabular-nums font-mono">{money(prior.closing_arrears)}</span>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span>{cur.label}</span>
                        <span className="tabular-nums font-mono">{money(cur.closing_arrears)}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">arrears only, each on its own period</p>
                    </div>

                    {/* Mobile */}
                    <div className="mt-4 space-y-3 sm:hidden">
                      {vRows.map((row) => (
                        <div
                          key={row.key}
                          className={`rounded-md border p-3 ${
                            row.current ? 'border-primary/30 bg-primary/5' : 'border-border/60'
                          }`}
                        >
                          <p className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            <span>{row.label}</span>
                            {row.stillCounting && (
                              <span className="font-medium normal-case text-primary">still counting</span>
                            )}
                          </p>
                          <div className="mt-2 space-y-1 text-sm">
                            <p className="flex items-baseline justify-between gap-3">
                              <span className="text-muted-foreground">Owed at start</span>
                              <span className="shrink-0 tabular-nums font-mono">{money(row.opening)}</span>
                            </p>
                            <p className="flex items-baseline justify-between gap-3">
                              <span className="text-muted-foreground">Owed at close</span>
                              <span className="shrink-0 tabular-nums font-mono">{money(row.closing)}</span>
                            </p>
                            <p className="flex items-baseline justify-between gap-3">
                              <span className="text-muted-foreground">Net change</span>
                              <span className={`shrink-0 tabular-nums font-mono ${netClass(row.net)}`}>
                                {signedMoney(row.net)}
                              </span>
                            </p>
                            <p className="flex items-baseline justify-between gap-3">
                              <span className="text-muted-foreground">Tenants owing</span>
                              <span className="shrink-0 tabular-nums font-mono">{row.tenants}</span>
                            </p>
                          </div>
                        </div>
                      ))}

                      <div className="rounded-md border border-border p-3 font-medium">
                        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Increase / decrease
                        </p>
                        <div className="mt-2 space-y-1 text-sm">
                          <p className="flex items-baseline justify-between gap-3">
                            <span className="text-muted-foreground">Owed at start</span>
                            <span className={`shrink-0 tabular-nums font-mono ${netClass(openingDelta)}`}>
                              {signedMoney(openingDelta)}
                            </span>
                          </p>
                          <p className="flex items-baseline justify-between gap-3">
                            <span className="text-muted-foreground">Owed at close</span>
                            <span className={`shrink-0 tabular-nums font-mono ${netClass(closingDelta)}`}>
                              {signedMoney(closingDelta)}
                            </span>
                          </p>
                          <p className="flex items-baseline justify-between gap-3">
                            <span className="text-muted-foreground">Net change</span>
                            <span className={`shrink-0 tabular-nums font-mono ${netClass(netDelta)}`}>
                              {signedMoney(netDelta)}
                            </span>
                          </p>
                          <p className="flex items-baseline justify-between gap-3">
                            <span className="text-muted-foreground">Tenants owing</span>
                            <span className={`shrink-0 tabular-nums font-mono ${netClass(tenantsDelta)}`}>
                              {tenantsDelta > 0 ? '+' : tenantsDelta < 0 ? '−' : ''}
                              {Math.abs(tenantsDelta)}
                            </span>
                          </p>
                        </div>
                      </div>
                    </div>

                    {/* Desktop */}
                    <div className="mt-4 hidden overflow-x-auto sm:block">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                            <th scope="col" className="py-2 pr-3 font-medium">Period</th>
                            <th scope="col" className="py-2 pr-3 text-right font-medium">Owed at start</th>
                            <th scope="col" className="py-2 pr-3 text-right font-medium">Owed at close</th>
                            <th scope="col" className="py-2 pr-3 text-right font-medium">Net change</th>
                            <th scope="col" className="py-2 text-right font-medium">Tenants owing</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vRows.map((row) => (
                            <tr
                              key={row.key}
                              className={`border-b border-border/60 ${row.current ? 'bg-primary/5' : ''}`}
                            >
                              <td className="py-2 pr-3">
                                <span className={row.current ? 'font-medium text-foreground' : ''}>
                                  {row.label}
                                </span>
                                {row.stillCounting && (
                                  <span className="ml-2 text-xs text-primary">still counting</span>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(row.opening)}</td>
                              <td className="py-2 pr-3 text-right tabular-nums font-mono">{money(row.closing)}</td>
                              <td className={`py-2 pr-3 text-right tabular-nums font-mono ${netClass(row.net)}`}>
                                {signedMoney(row.net)}
                              </td>
                              <td className="py-2 text-right tabular-nums font-mono">{row.tenants}</td>
                            </tr>
                          ))}
                          <tr className="font-medium">
                            <td className="py-2 pr-3">Increase / decrease</td>
                            <td className={`py-2 pr-3 text-right tabular-nums font-mono ${netClass(openingDelta)}`}>
                              {signedMoney(openingDelta)}
                            </td>
                            <td className={`py-2 pr-3 text-right tabular-nums font-mono ${netClass(closingDelta)}`}>
                              {signedMoney(closingDelta)}
                            </td>
                            <td className={`py-2 pr-3 text-right tabular-nums font-mono ${netClass(netDelta)}`}>
                              {signedMoney(netDelta)}
                            </td>
                            <td className={`py-2 text-right tabular-nums font-mono ${netClass(tenantsDelta)}`}>
                              {tenantsDelta > 0 ? '+' : tenantsDelta < 0 ? '−' : ''}
                              {Math.abs(tenantsDelta)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                );
              })()}

              {current && (
                <div className="rounded-md border p-3 mt-3">
                  <p className="text-sm text-foreground">
                    Owed at the start of {current.label} —{' '}
                    <span className="tabular-nums font-mono">{money(current.opening_arrears)}</span>
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    Owed now — <span className="tabular-nums font-mono">{money(current.closing_arrears)}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {current.plans_owing_close} tenants
                    </span>
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    {current.newly_in_arrears} tenants fell into arrears · {current.fully_cleared} cleared completely
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    Rolls into the next period as its opening balance —{' '}
                    <span className="tabular-nums font-mono">{money(current.closing_arrears)}</span>
                  </p>
                </div>
              )}

              {periods.some((p) => p.identity_residual !== 0) && (
                <p className="mt-3 text-sm text-destructive">
                  This period does not reconcile — a balance moved by something other than a scheduled instalment or a recorded payment.
                </p>
              )}

              <p className="mt-3 text-[11px] text-muted-foreground">
                Opening plus accrued, less credit already held and less what was paid, equals closing. Accrued is what the agreed plans fell due in the period on live schedule arithmetic, so it will not match the Scheduled due column above, which is frozen when the day first opens. Anything not paid stays in the balance and becomes the next period&apos;s opening figure.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}

export default ArrearsMovementA2b;
