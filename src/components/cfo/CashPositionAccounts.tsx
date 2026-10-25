import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Smartphone, Landmark, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ActualMoneyHeld } from '@/hooks/useActualMoneyHeld';
import type { PhoneMoneyLine } from '@/components/financial-ops/PhoneMoneyStatementSheet';

const fmt = (value: number) => `UGX ${Math.round(value).toLocaleString('en-US')}`;

export function CashPositionAccounts({ money, updatedAt, onSelect }: {
  money?: ActualMoneyHeld;
  updatedAt: number;
  onSelect: (line: PhoneMoneyLine) => void;
}) {
  const rows = [
    { name: 'MTN Mobile Money', type: 'Mobile Money', line: 'mtn_momo' as const, value: money?.mtn ?? 0, token: 'primary', Icon: Smartphone },
    { name: 'Airtel Money', type: 'Mobile Money', line: 'airtel_money' as const, value: money?.airtel ?? 0, token: 'success', Icon: Smartphone },
    { name: 'Verified Cash at Bank', type: 'Bank', line: 'banked_cash' as const, value: money?.bankedCash ?? 0, token: 'info', Icon: Landmark },
  ];
  const updated = updatedAt ? new Date(updatedAt).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
  return <>
    <section className="cash-account-chart cash-panel" aria-label="Cash by Account Type">
      <h2 className="text-sm font-semibold">Cash by Account Type</h2>
      <div className="mt-3 flex items-center gap-3">
        <div className="relative h-36 w-36 shrink-0">
          {money && money.total > 0 && <ResponsiveContainer width="100%" height="100%"><PieChart>
            <Pie data={rows} dataKey="value" nameKey="name" innerRadius={48} outerRadius={66} startAngle={90} endAngle={-270} stroke="none">
              {rows.map(row => <Cell key={row.line} fill={`hsl(var(--${row.token}))`} />)}
            </Pie><Tooltip formatter={(value: number) => fmt(value)} />
          </PieChart></ResponsiveContainer>}
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-[10px] text-muted-foreground">UGX</span>
            <strong className="text-lg">{money ? `${(money.total / 1e9).toFixed(2)}B` : '—'}</strong>
            <span className="text-[10px] text-muted-foreground">Total cash</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-3">{rows.map(row => <div key={row.line} className="text-[10px]">
          <p className="flex items-center gap-1.5 text-muted-foreground"><span className={`cash-dot cash-dot-${row.token}`} />{row.name}</p>
          <p className="mt-1 font-medium tabular-nums">{money ? fmt(row.value) : '—'}</p>
          <p className="text-muted-foreground">{money && money.total > 0 ? `${(row.value / money.total * 100).toFixed(1)}%` : '—'}</p>
        </div>)}</div>
      </div>
    </section>
    <section className="cash-account-table cash-panel" aria-label="Account Balances">
      <h2 className="mb-3 text-sm font-semibold">Account Balances</h2>
      <div className="overflow-x-auto"><table className="w-full text-left text-[11px]">
        <thead className="bg-muted/50 text-muted-foreground"><tr>{['Account Type', 'Account / Wallet', 'Balance (UGX)', 'Last Updated', 'Status', ''].map((heading, index) => <th key={index} className="px-2 py-2 font-medium">{heading}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.line} className="border-b border-border/60">
          <td className="px-2 py-2.5"><span className="flex items-center gap-2 whitespace-nowrap"><row.Icon className="h-4 w-4 text-primary" />{row.type}</span></td>
          <td className="px-2 py-2.5 whitespace-nowrap">{row.name}</td>
          <td className="px-2 py-2.5 font-medium tabular-nums whitespace-nowrap">{money ? fmt(row.value) : '—'}</td>
          <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">{updated} EAT</td>
          <td className="px-2 py-2.5"><span className={`rounded-full px-2 py-1 text-[10px] ${!money ? 'bg-muted text-muted-foreground' : row.line === 'banked_cash' && !money.bankedInSync ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}>{!money ? 'Checking' : row.line === 'banked_cash' ? money.bankedInSync ? 'Reconciled' : 'Review variance' : 'Reported'}</span></td>
          <td><Button variant="ghost" size="icon" className="h-8 w-8" aria-label={`View ${row.name}`} onClick={() => onSelect(row.line)}><ChevronRight className="h-3 w-3" /></Button></td>
        </tr>)}</tbody>
        <tfoot className="bg-muted/50 font-semibold"><tr><td colSpan={2} className="px-2 py-2.5">Total Money We Have</td><td colSpan={4} className="px-2 py-2.5 tabular-nums">{money ? fmt(money.total) : '—'}</td></tr></tfoot>
      </table></div>
    </section>
  </>;
}