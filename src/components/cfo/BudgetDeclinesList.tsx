import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';

interface Row {
  id: string; call_id: string; department_id: string; declined_by: string;
  reason: string; created_at: string;
  cycle?: string; department?: string; head?: string;
}

/** Read-only list of department budgets declined by their heads. */
export default function BudgetDeclinesList({ cycleId }: { cycleId: string | null }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let off = false;
    (async () => {
      setLoading(true); setError(null);
      let q = supabase.from('budget_obligation_declines' as never)
        .select('id,call_id,department_id,declined_by,reason,created_at')
        .order('created_at', { ascending: false }).limit(500);
      if (cycleId) q = q.eq('call_id', cycleId);
      const { data, error: e } = await q;
      if (off) return;
      if (e) { setError(e.message); setLoading(false); return; }
      const base = (data ?? []) as unknown as Row[];
      const uniq = (k: keyof Row) => [...new Set(base.map(r => r[k] as string))];
      const [calls, depts, profs] = await Promise.all([
        supabase.from('budget_calls').select('id,title').in('id', uniq('call_id')),
        supabase.from('hr_departments').select('id,name').in('id', uniq('department_id')),
        supabase.from('profiles').select('id,full_name').in('id', uniq('declined_by')),
      ]);
      if (off) return;
      const m = (r: { data: unknown }, f: string) =>
        new Map(((r.data ?? []) as Record<string, string>[]).map(x => [x.id, x[f]]));
      const cm = m(calls, 'title'), dm = m(depts, 'name'), pm = m(profs, 'full_name');
      setRows(base.map(r => ({
        ...r, cycle: cm.get(r.call_id), department: dm.get(r.department_id), head: pm.get(r.declined_by),
      })));
      setLoading(false);
    })();
    return () => { off = true; };
  }, [cycleId]);

  if (loading) return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (error) return <p className="text-sm text-destructive">Could not load declined budgets: {error}</p>;
  if (!rows.length) return <p className="py-8 text-center text-sm text-muted-foreground">No department has declined a budget.</p>;

  return (
    <div className="space-y-2">
      {rows.map(r => (
        <Card key={r.id}>
          <CardContent className="space-y-1 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{r.department ?? 'Department'}</span>
              <Badge variant="destructive">Declined</Badge>
              <span className="ml-auto text-xs text-muted-foreground">{format(new Date(r.created_at), 'd MMM yyyy, HH:mm')}</span>
            </div>
            <p className="text-xs text-muted-foreground">{r.cycle ?? 'Budget cycle'} · by {r.head ?? 'Department head'}</p>
            <p className="text-sm">{r.reason}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
