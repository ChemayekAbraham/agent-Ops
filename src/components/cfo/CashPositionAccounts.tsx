import { Smartphone, Landmark, ChevronRight, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import type { ActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import type { PhoneMoneyLine } from '@/components/financial-ops/PhoneMoneyStatementSheet';

const fmt = (value: number) => `UGX ${Math.round(value).toLocaleString('en-US')}`;

export function CashPositionAccounts({
  money,
  updatedAt,
  onSelect,
}: {
  money?: ActualMoneyHeld;
  updatedAt: number;
  onSelect: (line: PhoneMoneyLine) => void;
}) {
  const rows = [
    {
      name: 'MTN Mobile Money',
      type: 'Telecom Float Line',
      line: 'mtn_momo' as const,
      value: money?.mtn ?? 0,
      Icon: Smartphone,
      color: 'text-amber-500 bg-amber-500/10 border-amber-500/20',
    },
    {
      name: 'Airtel Money',
      type: 'Telecom Float Line',
      line: 'airtel_money' as const,
      value: money?.airtel ?? 0,
      Icon: Smartphone,
      color: 'text-rose-500 bg-rose-500/10 border-rose-500/20',
    },
    {
      name: 'Verified Cash at Bank',
      type: 'Corporate Banking',
      line: 'banked_cash' as const,
      value: money?.bankedCash ?? 0,
      Icon: Landmark,
      color: 'text-blue-500 bg-blue-500/10 border-blue-500/20',
    },
  ];

  const updated = updatedAt
    ? new Date(updatedAt).toLocaleString('en-GB', {
        timeZone: 'Africa/Kampala',
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

  return (
    <section className="cash-account-table cash-panel rounded-xl border border-border/80 bg-card p-4 shadow-xs" aria-label="Account Balances">
      {/* Executive Header */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Landmark className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground">
              Account Balances
            </h2>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Live line balances across telecom networks and corporate banking accounts
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
          <span>Authoritative Balances</span>
        </div>
      </div>

      {/* Ledger Table */}
      <div className="overflow-x-auto -mx-4 -mb-4 px-4 pb-4">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
              <th className="py-2.5 px-3 font-medium">Account / Provider</th>
              <th className="py-2.5 px-3 font-medium">Type</th>
              <th className="py-2.5 px-3 font-medium text-right">Balance (UGX)</th>
              <th className="py-2.5 px-3 font-medium">Last Synced</th>
              <th className="py-2.5 px-3 font-medium text-center">Status</th>
              <th className="py-2.5 px-2 text-right"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {rows.map((row) => (
              <tr
                key={row.line}
                onClick={() => onSelect(row.line)}
                className="group cursor-pointer hover:bg-muted/40 transition-colors"
              >
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${row.color}`}>
                      <row.Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="font-semibold text-foreground group-hover:text-primary transition-colors">
                      {row.name}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-3 text-muted-foreground text-[11px]">
                  <span className="rounded-md bg-muted/60 px-2 py-0.5 font-medium border border-border/60">
                    {row.type}
                  </span>
                </td>
                <td className="py-3 px-3 font-bold tabular-nums text-foreground text-right whitespace-nowrap">
                  {money ? fmt(row.value) : '—'}
                </td>
                <td className="py-3 px-3 whitespace-nowrap text-muted-foreground tabular-nums text-[11px]">
                  {updated} EAT
                </td>
                <td className="py-3 px-3 text-center">
                  {!money ? (
                    <Badge variant="outline" className="text-[10px] bg-muted text-muted-foreground">
                      Checking
                    </Badge>
                  ) : row.line === 'banked_cash' ? (
                    money.bankedInSync ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        Reconciled
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                        Review variance
                      </span>
                    )
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400 border border-blue-500/20">
                      <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                      Reported
                    </span>
                  )}
                </td>
                <td className="py-3 px-2 text-right">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground group-hover:text-primary transition-colors"
                    aria-label={`View ${row.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(row.line);
                    }}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border/80 bg-muted/20 font-bold text-foreground">
              <td colSpan={2} className="py-3 px-3 text-xs">
                Total Money We Have
              </td>
              <td className="py-3 px-3 text-right tabular-nums text-xs sm:text-sm font-extrabold text-foreground">
                {money ? fmt(money.total) : '—'}
              </td>
              <td colSpan={3} className="py-3 px-3 text-[11px] text-muted-foreground font-normal">
                Combined verified liquid holdings
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}
