import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/creditFeeCalculations';

/**
 * Facilitation register — COO and finance.
 * Reads the read-only view public.v_pso_facilitation_position.
 */

interface RegisterRow {
  requisition_id: string;
  requisition_code: string | null;
  officer_ref: string | null;
  officer_name: string | null;
  title: string | null;
  amount: number | null;
  position: string | null;
  submitted_at: string | null;
  days_since_disbursement: number | null;
  plan_total: number | null;
  report_filed: boolean | null;
  amount_received: number | null;
  amount_spent: number | null;
  balance: number | null;
  promissory_notes_linked: number | null;
  promissory_notes_value: number | null;
  times_deferred: number | null;
  exception_flag: string | null;
}

const FLAG_PRIORITY: Record<string, number> = {
  'ACCOUNTABILITY OVERDUE': 0,
  'REPEATEDLY DEFERRED': 1,
  'SPENT EXCEEDS RECEIVED': 2,
  'ACCOUNTABILITY DUE': 3,
  'APPROVED NOT DISBURSED': 4,
  'UNSPENT BALANCE': 5,
  'AWAITING APPROVAL': 6,
  OK: 7,
};

function flagTone(flag: string | null) {
  switch (flag) {
    case 'ACCOUNTABILITY OVERDUE':
    case 'SPENT EXCEEDS RECEIVED':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'REPEATEDLY DEFERRED':
    case 'ACCOUNTABILITY DUE':
    case 'UNSPENT BALANCE':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-700';
    case 'OK':
      return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700';
    default:
      return 'border-primary/30 bg-primary/10 text-primary';
  }
}

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function PsoFacilitationRegister() {
  const [flagFilter, setFlagFilter] = useState<string>('all');

  const { data, isLoading, error } = useQuery({
    queryKey: ['pso-facilitation-register'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_pso_facilitation_position')
        .select('*')
        .limit(500);
      if (error) throw error;
      return (data || []) as unknown as RegisterRow[];
    },
    staleTime: 60_000,
  });

  const rows = useMemo(() => {
    const list = [...(data || [])];
    list.sort((a, b) => {
      const pa = FLAG_PRIORITY[a.exception_flag || ''] ?? 8;
      const pb = FLAG_PRIORITY[b.exception_flag || ''] ?? 8;
      if (pa !== pb) return pa - pb;
      return (b.submitted_at || '').localeCompare(a.submitted_at || '');
    });
    return flagFilter === 'all' ? list : list.filter((r) => r.exception_flag === flagFilter);
  }, [data, flagFilter]);

  const flags = useMemo(() => {
    const counts = new Map<string, number>();
    (data || []).forEach((r) => {
      const f = r.exception_flag || 'OK';
      counts.set(f, (counts.get(f) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => (FLAG_PRIORITY[a[0]] ?? 8) - (FLAG_PRIORITY[b[0]] ?? 8));
  }, [data]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div>
        <h1 className="text-xl font-bold">Facilitation register</h1>
        <p className="text-sm text-muted-foreground">
          Every Platform Sales Officer facilitation, its position in the chain and its accountability status.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant={flagFilter === 'all' ? 'default' : 'outline'}
          onClick={() => setFlagFilter('all')}
        >
          All ({(data || []).length})
        </Button>
        {flags.map(([flag, count]) => (
          <Button
            key={flag}
            size="sm"
            variant={flagFilter === flag ? 'default' : 'outline'}
            onClick={() => setFlagFilter(flag)}
          >
            {flag} ({count})
          </Button>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{rows.length} facilitation{rows.length === 1 ? '' : 's'}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading the register…
            </div>
          ) : error ? (
            <div className="flex items-center justify-center gap-2 p-8 text-sm text-destructive">
              <AlertTriangle className="h-4 w-4" /> {(error as Error).message}
            </div>
          ) : rows.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">Nothing here yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/60 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left">Flag</th>
                    <th className="px-3 py-2 text-left">Officer</th>
                    <th className="px-3 py-2 text-left">Request</th>
                    <th className="px-3 py-2 text-right">Amount</th>
                    <th className="px-3 py-2 text-left">Position</th>
                    <th className="px-3 py-2 text-left">Submitted</th>
                    <th className="px-3 py-2 text-right">Received</th>
                    <th className="px-3 py-2 text-right">Spent</th>
                    <th className="px-3 py-2 text-right">Balance</th>
                    <th className="px-3 py-2 text-right">Notes</th>
                    <th className="px-3 py-2 text-right">Deferred</th>
                    <th className="px-3 py-2 text-right">Days out</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.requisition_id} className="border-t align-top">
                      <td className="px-3 py-2">
                        <Badge variant="outline" className={flagTone(r.exception_flag)}>
                          {r.exception_flag || 'OK'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{r.officer_name || '—'}</p>
                        <p className="text-muted-foreground">{r.officer_ref || ''}</p>
                      </td>
                      <td className="px-3 py-2">
                        <p className="font-medium">{r.title || '—'}</p>
                        <p className="text-muted-foreground">{r.requisition_code || ''}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-primary">
                        {formatUGX(Number(r.amount || 0))}
                      </td>
                      <td className="px-3 py-2">{r.position || '—'}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.submitted_at)}</td>
                      <td className="px-3 py-2 text-right">{r.amount_received != null ? formatUGX(Number(r.amount_received)) : '—'}</td>
                      <td className="px-3 py-2 text-right">{r.amount_spent != null ? formatUGX(Number(r.amount_spent)) : '—'}</td>
                      <td className="px-3 py-2 text-right">{r.balance != null ? formatUGX(Number(r.balance)) : '—'}</td>
                      <td className="px-3 py-2 text-right">
                        {Number(r.promissory_notes_linked || 0)}
                        {Number(r.promissory_notes_value || 0) > 0 && (
                          <span className="block text-muted-foreground">{formatUGX(Number(r.promissory_notes_value))}</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">{Number(r.times_deferred || 0)}</td>
                      <td className="px-3 py-2 text-right">{r.days_since_disbursement ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
