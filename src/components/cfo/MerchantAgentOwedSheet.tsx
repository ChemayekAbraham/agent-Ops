import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Loader2, Smartphone, Landmark } from 'lucide-react';
import { useMerchantAgentMoneyOwed } from '@/hooks/useMerchantAgentMoneyOwed';

const fmt = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

const day = (v: string | null) =>
  v
    ? new Date(v).toLocaleString('en-GB', {
        timeZone: 'Africa/Kampala',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Read-only drilldown behind the "In merchant agent hands" and "Bayo Mercy
 * account" lines on the CFO Money We Owe card. Every figure comes from the
 * Financial Ops email extractor; nothing is written here.
 */
export function MerchantAgentOwedSheet({ open, onOpenChange }: Props) {
  const { data, isLoading, error } = useMerchantAgentMoneyOwed(open);
  const agents = (data?.agents ?? []).filter((a) => a.still_held > 0 || a.email_sent_total > 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
        <SheetHeader className="text-left">
          <SheetTitle className="text-base">Money held outside the platform</SheetTitle>
          <SheetDescription className="text-xs">
            Built from the extracted MTN, Airtel and bank emails in Financial Ops. Read-only.
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <p className="py-10 text-sm text-destructive">
            Could not load this breakdown. You may not have permission to view it.
          </p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] text-muted-foreground">In merchant agent hands</p>
                <p className="mt-1 font-mono text-sm font-bold tabular-nums">
                  {fmt(data?.merchantAgentTotal ?? 0)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-muted/30 p-3">
                <p className="text-[11px] text-muted-foreground">Bayo Mercy account</p>
                <p className="mt-1 font-mono text-sm font-bold tabular-nums">
                  {fmt(data?.bayoMercyTotal ?? 0)}
                </p>
              </div>
              <div className="rounded-xl border border-orange-500/40 bg-orange-50/60 dark:bg-orange-950/20 p-3">
                <p className="text-[11px] text-orange-700 dark:text-orange-400">Total held outside</p>
                <p className="mt-1 font-mono text-sm font-bold tabular-nums text-orange-700 dark:text-orange-400">
                  {fmt(data?.total ?? 0)}
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-border p-3">
              <div className="flex items-center gap-2">
                <Landmark className="h-4 w-4 text-sky-600" />
                <p className="text-xs font-semibold">Bayo Mercy account</p>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Credits in less debits out on the account, from the extracted bank emails since the
                reconciliation reset.
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-emerald-600" />
                <p className="text-xs font-semibold">Merchant agents ({agents.length})</p>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Sent to their number in the emails, less what they sent back, less payouts they have
                already completed for us.
              </p>

              {agents.length === 0 ? (
                <p className="py-6 text-xs text-muted-foreground">
                  No merchant agent movements found in the extracted emails.
                </p>
              ) : (
                agents.map((a) => (
                  <div key={a.desk_id} className="rounded-xl border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{a.agent_name}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {a.phone || 'No number on record'}
                          {a.label ? ` · ${a.label}` : ''}
                        </p>
                      </div>
                      <p className="shrink-0 font-mono text-sm font-bold tabular-nums text-orange-600">
                        {fmt(a.still_held)}
                      </p>
                    </div>
                    <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
                      <div>
                        <span className="text-muted-foreground">Sent to them</span>
                        <p className="font-mono tabular-nums">{fmt(a.email_sent_total)}</p>
                        <span className="text-muted-foreground">{a.email_sent_count} email(s)</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Sent back</span>
                        <p className="font-mono tabular-nums">{fmt(a.email_returned_total)}</p>
                        <span className="text-muted-foreground">{a.email_returned_count} email(s)</span>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Paid out for us</span>
                        <p className="font-mono tabular-nums">{fmt(a.paid_out_total)}</p>
                        <span className="text-muted-foreground">Last sent {day(a.last_sent_at)}</span>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
