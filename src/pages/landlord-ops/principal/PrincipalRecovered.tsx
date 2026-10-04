import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUGX } from '@/lib/rentCalculations';

interface PrincipalRow {
  id: string;
  repayment_date: string;
  tenant_name: string | null;
  landlord_name: string | null;
  rent_request_id: string | null;
  total_repayment: number | string;
  principal: number | string;
  returns: number | string;
  agent_commission: number | string;
  platform_fee: number | string;
  access_fee: number | string;
  registration_fee: number | string;
  plan_status: string | null;
  plan_rent_amount: number | string | null;
  plan_start: string | null;
  plan_duration_days: number | null;
  plan_house_category: string | null;
}

type RangedRpc = (
  fn: string,
  args: { p_from: string | null; p_to: string | null },
) => { range: (from: number, to: number) => PromiseLike<{ data: PrincipalRow[] | null; error: Error | null }> };

/** Kampala (EAT) calendar date as YYYY-MM-DD, offset by n days. */
function kampalaDate(offsetDays = 0): string {
  const d = new Date(Date.now() + 3 * 3600_000 + offsetDays * 86400_000);
  return d.toISOString().slice(0, 10);
}

function buildPeriods() {
  const today = kampalaDate();
  const t = new Date(today + 'T00:00:00Z');
  const dow = (t.getUTCDay() + 6) % 7;
  const dom = t.getUTCDate();
  const list: { key: string; label: string; from: string | null; to: string | null }[] = [
    { key: 'today', label: 'Today', from: today, to: today },
    { key: 'yesterday', label: 'Yesterday', from: kampalaDate(-1), to: kampalaDate(-1) },
    { key: 'this_week', label: 'This week', from: kampalaDate(-dow), to: today },
    { key: 'past_7_days', label: 'Past 7 days', from: kampalaDate(-6), to: today },
    { key: 'this_month', label: 'This month', from: kampalaDate(-(dom - 1)), to: today },
  ];
  // Previous two calendar months
  for (let i = 1; i <= 2; i++) {
    const s = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i, 1));
    const e = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - i + 1, 0));
    list.push({
      key: `m${i}`,
      label: s.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      from: s.toISOString().slice(0, 10),
      to: e.toISOString().slice(0, 10),
    });
  }
  list.push({ key: 'all', label: 'All time', from: null, to: null });
  return list;
}

export default function PrincipalRecovered() {
  const periods = useMemo(buildPeriods, []);
  const [key, setKey] = useState('today');
  const period = periods.find((p) => p.key === key)!;

  const { data: rows = [], isFetching, error } = useQuery({
    queryKey: ['landlord-ops-principal-rows', period.from, period.to],
    staleTime: 0,
    queryFn: async () => {
      // Server caps each response at 1,000 rows — fetch in stable-ordered batches until done.
      const PAGE = 1000;
      const all: PrincipalRow[] = [];
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await (supabase.rpc as unknown as RangedRpc)('landlord_ops_principal_recovered_rows', {
          p_from: period.from,
          p_to: period.to,
        }).range(offset, offset + PAGE - 1);
        if (error) throw error;
        const batch = (data ?? []) as PrincipalRow[];
        all.push(...batch);
        if (batch.length < PAGE) break;
      }
      return all;
    },
  });

  const totals = useMemo(
    () =>
      rows.reduce(
        (a, r) => ({
          total: a.total + Number(r.total_repayment),
          principal: a.principal + Number(r.principal),
          other: a.other + Number(r.total_repayment) - Number(r.principal),
        }),
        { total: 0, principal: 0, other: 0 },
      ),
    [rows],
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link to="/landlord-ops" aria-label="Back"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div>
          <h1 className="text-lg font-bold">Landlord Principal Recovered</h1>
          <p className="text-xs text-muted-foreground">
            Tenant repayments behind the KPI — reversed repayments excluded. Dates in Kampala time.
          </p>
        </div>
      </div>

      <Tabs value={key} onValueChange={setKey}>
        <TabsList className="flex h-auto flex-wrap justify-start">
          {periods.map((p) => (
            <TabsTrigger key={p.key} value={p.key} className="text-xs">{p.label}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          ['Principal recovered', formatUGX(totals.principal)],
          ['Total repayments', formatUGX(totals.total)],
          ['Other components', formatUGX(totals.other)],
          ['Repayments', rows.length.toLocaleString()],
        ].map(([l, v]) => (
          <Card key={l} className="p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{l}</p>
            <p className="mt-1 text-lg font-bold tabular-nums">{v}</p>
          </Card>
        ))}
      </div>

      <Card className="overflow-x-auto">
        {isFetching ? (
          <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : error ? (
          <p className="p-6 text-sm text-destructive">Could not load repayments: {(error as Error).message}</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No repayments in this period.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-border bg-muted/40 text-left text-muted-foreground">
              <tr>
                {['Date', 'Tenant', 'Rent Plan', 'Landlord', 'Total', 'Principal', 'Other components', 'Status'].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {new Date(r.repayment_date).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' })}
                  </td>
                  <td className="px-3 py-2">{r.tenant_name ?? '—'}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium whitespace-nowrap">
                      {r.plan_rent_amount != null ? formatUGX(Number(r.plan_rent_amount)) : 'Rent Plan'}
                      {r.plan_duration_days ? ` · ${r.plan_duration_days} days` : ''}
                    </div>
                    <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {r.plan_start ? `Started ${new Date(r.plan_start).toLocaleDateString('en-GB', { timeZone: 'Africa/Kampala', day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                      {r.plan_house_category ? ` · ${String(r.plan_house_category).replace(/_/g, ' ')}` : ''}
                      {` · RP-${String(r.rent_request_id ?? '').slice(0, 6).toUpperCase()}`}
                    </div>
                  </td>
                  <td className="px-3 py-2">{r.landlord_name ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatUGX(Number(r.total_repayment))}</td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatUGX(Number(r.principal))}</td>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                    Returns {formatUGX(Number(r.returns))} · Commission {formatUGX(Number(r.agent_commission))} · Platform fee {formatUGX(Number(r.platform_fee))} · Access fee {formatUGX(Number(r.access_fee))} · Registration {formatUGX(Number(r.registration_fee))}
                  </td>
                  <td className="px-3 py-2"><Badge variant="outline" className="text-[10px]">{(r.plan_status ?? '—').replace(/_/g, ' ')}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
