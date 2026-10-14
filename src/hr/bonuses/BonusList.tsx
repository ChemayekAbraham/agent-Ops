import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Plus } from 'lucide-react';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { listPools, type BonusPool } from './api';
import { BONUS_STATUS_LABEL } from './bonusMath';

export function StatusBadge({ status }: { status: string }) {
  const variant = status === 'paid' ? 'default' : status === 'cancelled' ? 'outline' : status === 'returned' ? 'destructive' : 'secondary';
  return <Badge variant={variant as any}>{BONUS_STATUS_LABEL[status] ?? status}</Badge>;
}

export default function BonusList() {
  const [rows, setRows] = useState<BonusPool[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listPools().then(setRows).catch((e: Error) => { setError(e.message); setRows([]); });
  }, []);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Bonuses</h1>
          <p className="text-sm text-muted-foreground">Paid to each person's Welile wallet, outside payroll.</p>
        </div>
        <Button onClick={() => navigate('/hr/bonuses/new')}><Plus className="mr-1 h-4 w-4" /> New bonus pool</Button>
      </div>
      {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      {rows === null ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : rows.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground">No bonus pools yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3">Title</th><th className="p-3 text-right">Pool</th><th className="p-3 text-right">Allocated</th>
                <th className="p-3 text-right">People</th><th className="p-3">Status</th>
                <th className="p-3">Prepared by</th><th className="p-3">Approved by</th><th className="p-3">Paid by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pool_id} className="border-t hover:bg-muted/30">
                  <td className="p-3 font-medium"><Link className="text-primary hover:underline" to={`/hr/bonuses/${r.pool_id}`}>{r.title}</Link></td>
                  <td className="p-3 text-right tabular-nums">{formatUGX(Number(r.pool_amount))}</td>
                  <td className="p-3 text-right tabular-nums">{formatUGX(Number(r.allocated))}</td>
                  <td className="p-3 text-right">{r.people}</td>
                  <td className="p-3"><StatusBadge status={r.status} /></td>
                  <td className="p-3">{r.prepared_by_name ?? '—'}</td>
                  <td className="p-3">{r.approved_by_name ?? '—'}</td>
                  <td className="p-3">{r.paid_by_name ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
