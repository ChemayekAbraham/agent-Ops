import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
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
            <span className="text-sm font-bold text-foreground tabular-nums">
              {isPending || !current ? '…' : money(current.closing_arrears)}
            </span>
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {isPending || !current ? (
              'how the balance owed moved, period by period'
            ) : (
              <>
                owed now ·{' '}
                <span className={netClass(current.net_added_to_arrears)}>
                  {signedMoney(current.net_added_to_arrears)}
                </span>{' '}
                this {granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month'} ·{' '}
                {money(current.cleared_by_payment)} cleared
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
                        <td className="py-2 pr-3 text-right tabular-nums">{money(p.opening_arrears)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(p.accrued)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(p.prepaid_credit_absorbed)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums text-emerald-600">{money(p.cleared_by_payment)}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{money(p.closing_arrears)}</td>
                        <td className={`py-2 text-right tabular-nums ${netClass(p.net_added_to_arrears)}`}>
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
                        <p className="text-sm tabular-nums">{money(p.opening_arrears)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Accrued</p>
                        <p className="text-sm tabular-nums">{money(p.accrued)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Credit used</p>
                        <p className="text-sm tabular-nums">{money(p.prepaid_credit_absorbed)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Cleared</p>
                        <p className="text-sm tabular-nums text-emerald-600">{money(p.cleared_by_payment)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Closing</p>
                        <p className="text-sm tabular-nums">{money(p.closing_arrears)}</p>
                      </div>
                      <div>
                        <p className="text-[11px] text-muted-foreground">Net change</p>
                        <p className={`text-sm tabular-nums ${netClass(p.net_added_to_arrears)}`}>
                          {signedMoney(p.net_added_to_arrears)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {current && (
                <div className="rounded-md border p-3 mt-3">
                  <p className="text-sm text-foreground">
                    Owed at the start of {current.label} — {money(current.opening_arrears)}
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    Owed now — {money(current.closing_arrears)}
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      {current.plans_owing_close} tenants
                    </span>
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    {current.newly_in_arrears} tenants fell into arrears · {current.fully_cleared} cleared completely
                  </p>
                  <p className="mt-2 text-sm text-foreground">
                    Rolls into the next period as its opening balance — {money(current.closing_arrears)}
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
