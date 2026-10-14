import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Loader2, Sprout } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

type Row = {
  rent_request_id: string;
  tenant_name: string | null;
  tenant_phone: string | null;
  agent_name: string | null;
  landlord_paid_on: string;
  clock_start: string;
  daily_due: number;
  total_repayment: number;
  day_paid: number[];
  paid_7d: number;
};

const kampalaToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** First 7 Days New Tenant Repayment Tracker — all figures from `am_new_tenant_first7`. */
export function NewTenantFirst7Tracker() {
  const today = kampalaToday();
  const [paidOn, setPaidOn] = useState(addDays(today, -1));

  const { data, isLoading, error } = useQuery({
    queryKey: ['am-new-tenant-first7', paidOn],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('am_new_tenant_first7', { p_paid_on: paidOn });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });

  const rows = data ?? [];
  const totals = useMemo(() => {
    const t = Array(7).fill(0);
    rows.forEach((r) => r.day_paid?.forEach((v, i) => (t[i] += Number(v || 0))));
    return t;
  }, [rows]);

  const cellTone = (paid: number, due: number, date: string) => {
    if (date > today) return 'bg-muted/40 text-muted-foreground';
    if (paid <= 0) return 'bg-destructive/15 text-destructive';
    if (due > 0 && paid < due) return 'bg-warning/15 text-warning';
    return 'bg-success/15 text-success';
  };

  return (
    <Card className="p-3 space-y-3 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sprout className="h-4 w-4 text-primary" />
          <div>
            <p className="text-sm font-bold">First 7 Days — New Tenant Repayment Tracker</p>
            <p className="text-[11px] text-muted-foreground">
              Tenants whose landlord was paid on the chosen date. Day 1 is the next day.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Landlord paid on
          <Input type="date" value={paidOn} max={today} onChange={(e) => e.target.value && setPaidOn(e.target.value)} className="h-8 w-auto text-xs" />
        </label>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <p className="text-xs text-destructive">Could not load the tracker: {(error as Error).message}</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No new tenants had their landlord paid on this date.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 pr-2">Tenant</th>
                <th className="py-1 pr-2">Agent</th>
                <th className="py-1 pr-2 text-right">Daily</th>
                {Array.from({ length: 7 }, (_, i) => (
                  <th key={i} className="py-1 px-1 text-center">Day {i + 1}<br /><span className="font-normal">{addDays(paidOn, i + 1).slice(5)}</span></th>
                ))}
                <th className="py-1 pl-2 text-right">7-day paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const due = Number(r.daily_due || 0);
                const elapsed = Math.max(0, Math.min(7, Math.round((Date.parse(today) - Date.parse(paidOn)) / 86400000)));
                return (
                  <tr key={r.rent_request_id} className="border-t border-border/40">
                    <td className="py-1.5 pr-2"><p className="font-semibold">{r.tenant_name ?? '—'}</p><p className="text-muted-foreground">{r.tenant_phone ?? ''}</p></td>
                    <td className="py-1.5 pr-2">{r.agent_name ?? '—'}</td>
                    <td className="py-1.5 pr-2 text-right font-mono">{formatUGX(due)}</td>
                    {Array.from({ length: 7 }, (_, i) => {
                      const date = addDays(paidOn, i + 1);
                      const paid = Number(r.day_paid?.[i] || 0);
                      return (
                        <td key={i} className="px-0.5 py-1">
                          <div className={`rounded px-1 py-1 text-center font-mono ${cellTone(paid, due, date)}`}>
                            {date > today ? '—' : paid > 0 ? paid.toLocaleString('en-UG') : '0'}
                          </div>
                        </td>
                      );
                    })}
                    <td className="py-1.5 pl-2 text-right font-mono">
                      {formatUGX(Number(r.paid_7d || 0))}
                      <p className="text-muted-foreground">of {formatUGX(due * elapsed)}</p>
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-border font-semibold">
                <td className="py-1.5" colSpan={3}>{rows.length} tenants — total</td>
                {totals.map((t, i) => <td key={i} className="px-1 text-center font-mono">{t.toLocaleString('en-UG')}</td>)}
                <td className="pl-2 text-right font-mono">{formatUGX(totals.reduce((a, b) => a + b, 0))}</td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-[10px] text-muted-foreground">Green: paid in full · Amber: part paid · Red: nothing paid · Grey: day not reached yet. Amounts in UGX.</p>
        </div>
      )}
    </Card>
  );
}
