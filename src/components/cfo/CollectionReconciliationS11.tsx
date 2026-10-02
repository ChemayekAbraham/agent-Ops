import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

const RESULTS = ['System-consistent', 'System-inconsistent', 'System duplicate candidate', 'System-unsupported'];

type Row = {
  collection_id: string; collected_at: string; agent_name: string; tenant_name: string; rent_plan_id: string;
  amount: number; original_classification: string; reconciliation_result: string; ledger_group: string | null;
  ledger_receipt: number | null; float_before: number; float_after: number; plan_sequence: number;
  dup_other: string | null; findings: string; external_evidence_required: boolean;
};

export function CollectionReconciliationS11() {
  const [filter, setFilter] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ['cfo-collection-reconciliation-s11'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_collection_reconciliation_s11');
      if (error) throw error;
      return (data ?? []) as Row[];
    },
  });
  const rows = q.data ?? [];
  const sum = (f: (r: Row) => boolean) => {
    const s = rows.filter(f);
    return { count: s.length, amount: s.reduce((a, r) => a + Number(r.amount), 0) };
  };
  const shown = useMemo(() => (filter ? rows.filter((r) => r.reconciliation_result === filter) : rows), [rows, filter]);
  const total = sum(() => true);
  const ext = sum((r) => r.external_evidence_required);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Stage 11 — Agent Collection Reconciliation</CardTitle>
        <Badge variant="outline">Read-only investigation</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : q.error ? (
          <p className="text-sm text-destructive">{(q.error as Error).message}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {total.count} collections — {formatUGX(total.amount)}. Internal records are system evidence only, not proof cash was paid.
            </p>
            <div className="grid gap-3 sm:grid-cols-5">
              {RESULTS.map((k) => {
                const v = sum((r) => r.reconciliation_result === k);
                return (
                  <button key={k} onClick={() => setFilter(filter === k ? null : k)}
                    className={`rounded-md border p-3 text-left ${filter === k ? 'border-primary' : 'border-border'}`}>
                    <p className="text-xs text-muted-foreground">{k}</p>
                    <p className="text-lg font-semibold">{v.count}</p>
                    <p className="text-sm">{formatUGX(v.amount)}</p>
                  </button>
                );
              })}
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">Requires external evidence</p>
                <p className="text-lg font-semibold">{ext.count}</p>
                <p className="text-sm">{formatUGX(ext.amount)}</p>
              </div>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground"><th>Result</th><th className="text-right">Indeterminate</th><th className="text-right">Unsupported</th></tr></thead>
              <tbody>
                {RESULTS.map((k) => (
                  <tr key={k} className="border-t border-border"><td className="py-1">{k}</td>
                    {['Indeterminate', 'Unsupported'].map((o) => {
                      const v = sum((r) => r.reconciliation_result === k && r.original_classification === o);
                      return <td key={o} className="text-right">{v.count} · {formatUGX(v.amount)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {filter && <Button variant="outline" size="sm" onClick={() => setFilter(null)}>Show all</Button>}
            <div className="max-h-[480px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-background"><tr className="text-left text-muted-foreground">
                  <th>Collected (EAT)</th><th>Agent</th><th>Tenant</th><th className="text-right">Amount</th><th>Original</th><th>Stage 11</th><th>Ledger group</th><th className="text-right">Float before/after</th><th>#</th><th>Findings</th>
                </tr></thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.collection_id} className="border-t border-border align-top">
                      <td className="py-1 whitespace-nowrap">{new Date(r.collected_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}</td>
                      <td>{r.agent_name}</td><td>{r.tenant_name}</td>
                      <td className="text-right whitespace-nowrap">{formatUGX(Number(r.amount))}</td>
                      <td>{r.original_classification}</td><td>{r.reconciliation_result}</td>
                      <td className="font-mono">{r.ledger_group?.slice(0, 8) ?? '—'}</td>
                      <td className="text-right whitespace-nowrap">{formatUGX(Number(r.float_before))} / {formatUGX(Number(r.float_after))}</td>
                      <td>{r.plan_sequence}</td>
                      <td className="text-muted-foreground">{r.findings}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
