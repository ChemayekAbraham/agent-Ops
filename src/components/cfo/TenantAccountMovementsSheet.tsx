import { format } from 'date-fns';
import { ArrowDownLeft, ArrowUpRight, FileText, Loader2, Receipt } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatUGX } from '@/lib/rentCalculations';
import { useTenantAccountMovements } from '@/hooks/useReceivables';

interface Props {
  tenantId: string | null;
  tenantName?: string | null;
  locationLabel?: string | null;
  onClose: () => void;
}

const dt = (v?: string | null, withTime = false) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return format(d, withTime ? 'dd MMM yyyy HH:mm' : 'dd MMM yyyy');
};

/**
 * Deepest drilldown: one tenant account, the rent plans that booked the balance,
 * the field receipts collected, and every cash-in / cash-out ledger movement.
 * Read-only — nothing here writes to wallets, the ledger or collections.
 */
export function TenantAccountMovementsSheet({ tenantId, tenantName, locationLabel, onClose }: Props) {
  const { data, isLoading, error } = useTenantAccountMovements(tenantId);

  return (
    <Sheet open={!!tenantId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="center" className="overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <SheetHeader className="text-left">
          <SheetTitle className="text-base sm:text-lg break-words">
            {data?.tenant || tenantName || 'Tenant account'}
          </SheetTitle>
          <p className="text-[11px] text-muted-foreground">
            {locationLabel ? `${locationLabel} · ` : ''}
            {data?.phone || 'no phone on file'}
          </p>
        </SheetHeader>

        {isLoading && (
          <div className="flex justify-center py-10">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {error && (
          <p className="py-6 text-xs text-destructive">Could not load this account right now.</p>
        )}

        {data && (
          <div className="mt-3 space-y-3">
            {/* Balance summary */}
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-xl border border-primary/20 bg-primary/5 p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Outstanding</p>
                <p className="text-lg font-bold font-mono tabular-nums">{formatUGX(data.outstanding)}</p>
              </div>
              <div className="rounded-xl border border-border/60 bg-card p-3">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Booked · repaid</p>
                <p className="text-xs font-mono tabular-nums">
                  {formatUGX(data.totals.booked_total)} · {formatUGX(data.totals.repaid_total)}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground font-mono tabular-nums">
                  In {formatUGX(data.totals.ledger_cash_in)} · Out {formatUGX(data.totals.ledger_cash_out)}
                </p>
              </div>
            </div>

            {/* Open receivable items */}
            <section className="rounded-xl border border-border/60 bg-card p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <FileText className="h-3 w-3" /> Open items building the balance
              </p>
              {data.open_items.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No open items.</p>
              )}
              <div className="space-y-1">
                {data.open_items.map((it) => (
                  <div key={it.item_id} className="flex items-center justify-between gap-2 border-b border-border/40 pb-1 last:border-0">
                    <span className="min-w-0">
                      <span className="block truncate text-[11px]">{it.product}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {it.due_kind === 'scheduled' ? 'Due' : 'Est.'} {dt(it.due_date)}
                        {it.status ? ` · ${it.status}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-[11px]">{formatUGX(it.amount)}</span>
                  </div>
                ))}
              </div>
            </section>

            {/* Bookings */}
            <section className="rounded-xl border border-border/60 bg-card p-3">
              <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Rent plans booked
              </p>
              {data.bookings.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No rent plans on this account.</p>
              )}
              <div className="space-y-1.5">
                {data.bookings.map((b) => (
                  <div key={b.rent_request_id} className="rounded-lg bg-muted/30 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">{b.status || 'unknown'}</Badge>
                      <span className="font-mono tabular-nums text-[11px] font-semibold">
                        {formatUGX(b.outstanding)}
                      </span>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground font-mono tabular-nums">
                      Booked {formatUGX(b.total_repayment ?? 0)} · repaid {formatUGX(b.amount_repaid)} ·{' '}
                      {formatUGX(b.daily_repayment ?? 0)}/period · {b.duration_days ?? 0} days
                    </p>
                    <p className="text-[10px] text-muted-foreground">
                      Raised {dt(b.created_at)}
                      {b.disbursed_at ? ` · disbursed ${dt(b.disbursed_at)}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            {/* Field receipts */}
            <section className="rounded-xl border border-border/60 bg-card p-3">
              <p className="mb-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                <Receipt className="h-3 w-3" /> Field receipts ({formatUGX(data.totals.field_receipts_total)})
              </p>
              {data.field_receipts.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No field receipts recorded.</p>
              )}
              <div className="max-h-56 overflow-y-auto">
                {data.field_receipts.map((r) => (
                  <div key={r.collection_id} className="flex items-center justify-between gap-2 border-b border-border/40 py-1 last:border-0">
                    <span className="min-w-0">
                      <span className="block truncate text-[11px]">{r.agent || 'Collector'}</span>
                      <span className="block text-[10px] text-muted-foreground">
                        {dt(r.created_at, true)} · {r.payment_method || 'method n/a'}
                        {r.is_partial ? ' · partial' : ''}
                      </span>
                    </span>
                    <span className="shrink-0 font-mono tabular-nums text-[11px] text-emerald-600">
                      {formatUGX(r.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* Ledger movements */}
            <section className="rounded-xl border border-border/60 bg-card p-3">
              <p className="mb-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                Cash-in / cash-out movements
              </p>
              {data.ledger_movements.length === 0 && (
                <p className="text-[11px] text-muted-foreground">No ledger movements on this account.</p>
              )}
              <div className="max-h-72 overflow-y-auto">
                {data.ledger_movements.map((m) => {
                  const inbound = m.direction === 'cash_in';
                  return (
                    <div key={m.entry_id} className="flex items-start justify-between gap-2 border-b border-border/40 py-1 last:border-0">
                      <span className="flex min-w-0 items-start gap-1.5">
                        {inbound ? (
                          <ArrowDownLeft className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" />
                        ) : (
                          <ArrowUpRight className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-[11px]">{m.category || 'movement'}</span>
                          <span className="block text-[10px] text-muted-foreground line-clamp-2">
                            {dt(m.transaction_date, true)}
                            {m.ledger_scope ? ` · ${m.ledger_scope}` : ''}
                            {m.classification && m.classification !== 'production' ? ` · ${m.classification}` : ''}
                            {m.description ? ` · ${m.description}` : ''}
                          </span>
                        </span>
                      </span>
                      <span
                        className={`shrink-0 font-mono tabular-nums text-[11px] ${
                          inbound ? 'text-emerald-600' : 'text-destructive'
                        }`}
                      >
                        {inbound ? '+' : '−'}
                        {formatUGX(m.amount)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            <p className="text-[10px] text-muted-foreground">Source: {data.source}</p>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default TenantAccountMovementsSheet;
