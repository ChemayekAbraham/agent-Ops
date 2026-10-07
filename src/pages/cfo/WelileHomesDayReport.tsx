import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';

interface TaggedPayment {
  tag_id: string; posted_at: string; payment_reference: string; requisition_ref: string | null;
  recipient: string; amount: number; ledger_category: string; purpose: string; review_flag: string | null; status: string;
}
interface DayReport {
  day: string; payments: TaggedPayment[]; payments_total: number; payments_count: number;
  rent_collected: number; amount_owed_due_today: number; arrears_to_date: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  research_development_expense: 'Research & Development',
  payroll_expense: 'Payroll',
};
const kampalaToday = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

/** Read-only: Welile Homes payments/costs come from reporting tags, never from ledger categories. */
export default function WelileHomesDayReport() {
  const [params, setParams] = useSearchParams();
  const day = params.get('date') ?? kampalaToday();
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: ['cfo-welile-homes-day', day],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_welile_homes_day_report', { p_day: day });
      if (error) throw error;
      return data as unknown as DayReport;
    },
  });
  const d = q.data;
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <div className="min-h-screen bg-background p-4 md:p-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="sm"><Link to="/cfo/dashboard"><ArrowLeft className="h-4 w-4 mr-1" />Back</Link></Button>
        <h1 className="text-xl font-semibold text-foreground">Welile Homes — {label}</h1>
        <Input type="date" value={day} onChange={(e) => e.target.value && setParams({ date: e.target.value }, { replace: true })} className="w-44 ml-auto" />
      </div>

      {q.error && <p className="text-sm text-destructive">Could not load report: {(q.error as Error).message}</p>}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {d && <>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          {[
            ['Payments / Costs', formatUGX(d.payments_total)],
            ['Payments', String(d.payments_count)],
            ['Rent Collected', formatUGX(d.rent_collected)],
            ['Amount Owed (due this day)', formatUGX(d.amount_owed_due_today)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-border bg-card p-4">
              <p className="text-xs text-muted-foreground">{k}</p>
              <p className="text-lg font-semibold text-foreground mt-1">{v}</p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Payments/costs are existing posted payments linked to Welile Homes for reporting; they are not rent collected.
          Total unpaid Welile Homes dues up to this day: {formatUGX(d.arrears_to_date)}.
        </p>

        <div className="rounded-xl border border-border bg-card">
          <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 p-4 text-sm font-medium text-foreground">
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Individual payments ({d.payments_count})
          </button>
          {open && (d.payments.length === 0
            ? <p className="px-4 pb-4 text-xs text-muted-foreground">No Welile Homes payments on this day.</p>
            : <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-t border-border">
                  <tr>{['Date / time', 'Payment reference', 'Recipient', 'Amount', 'Ledger category', 'Welile Homes purpose', 'Status'].map((h) => <th key={h} className="text-left font-medium p-3">{h}</th>)}</tr>
                </thead>
                <tbody>
                  {d.payments.map((p) => (
                    <tr key={p.tag_id} className="border-t border-border align-top">
                      <td className="p-3 whitespace-nowrap">{new Date(p.posted_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}</td>
                      <td className="p-3">{p.payment_reference}{p.requisition_ref && <div className="text-xs text-muted-foreground">{p.requisition_ref}</div>}</td>
                      <td className="p-3">{p.recipient}</td>
                      <td className="p-3 whitespace-nowrap font-medium">{formatUGX(p.amount)}</td>
                      <td className="p-3">
                        {CATEGORY_LABELS[p.ledger_category] ?? p.ledger_category}
                        {p.review_flag && <div className="mt-1"><Badge variant="outline" className="border-warning text-warning gap-1"><AlertTriangle className="h-3 w-3" />{CATEGORY_LABELS[p.ledger_category] ?? 'Classification'} classification — CFO review pending</Badge></div>}
                      </td>
                      <td className="p-3">{p.purpose}</td>
                      <td className="p-3">{p.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>)}
        </div>
      </>}
    </div>
  );
}
