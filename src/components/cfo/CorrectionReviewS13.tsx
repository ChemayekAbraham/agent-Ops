import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Lock } from 'lucide-react';
import { formatUGX } from '@/lib/businessAdvanceCalculations';

const eat = (d: string) => new Date(d).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });
const LABEL: Record<string, string> = {
  'System-inconsistent': 'Agent mismatch',
  'System duplicate candidate': 'Duplicate',
  'System-consistent': 'System-consistent',
};

/** Stage 13 — read-only correction eligibility. No write path exists on this screen. */
export function CorrectionReviewS13() {
  const q = useQuery({
    queryKey: ['cfo-s13-correction-review'],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('cfo_s13_correction_review');
      if (error) throw error;
      return data as any;
    },
  });
  const d = q.data;
  const cands: any[] = d?.candidates ?? [];
  const total = cands.reduce((a, c) => a + Number(c.amount), 0);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Stage 13 — Correction Review</CardTitle>
        <Badge variant="outline">Read-only · Nothing posts</Badge>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground"><Lock className="h-3 w-3" />Only cases with a Stage 12 conclusion of Confirmed Duplicate or Confirmed Agent Mismatch can be correction candidates. This screen cannot post, reverse or change anything.</div>
        {q.isLoading && <p className="text-muted-foreground">Loading…</p>}
        {q.error && <p className="text-destructive">{(q.error as Error).message}</p>}
        {d && (<>
          <p>Stage 11: {d.controls.stage11_count} / {formatUGX(Number(d.controls.stage11_amount))} · Stage 12 decisions: {d.controls.decisions}</p>
          <div>
            <p className="font-medium mb-1">1. Correction candidates — {cands.length} / {formatUGX(total)}</p>
            {cands.length === 0 ? <p className="text-muted-foreground">No case has an evidence conclusion that establishes a correction condition, so there are no correction candidates.</p> : (
              <table className="w-full"><thead><tr className="text-left text-muted-foreground"><th>Collection</th><th>Date/time</th><th>Tenant</th><th>Rent Plan</th><th className="text-right">Amount</th><th>Stage 11</th><th>Stage 12 decision</th><th>Evidence</th><th>Proposed correction</th><th>Financial impact</th></tr></thead>
                <tbody>{cands.map((c) => (
                  <tr key={c.collection_id} className="border-t border-border"><td className="font-mono">{c.collection_id.slice(0, 8)}</td><td>{eat(c.collected_at)}</td><td>{c.tenant_name}</td><td className="font-mono">{c.rent_plan_id?.slice(0, 8)}</td>
                    <td className="text-right">{formatUGX(Number(c.amount))}</td><td>{c.stage11}</td><td>{c.stage12}</td><td>{c.evidence_reference ?? '—'}</td><td>Not yet proposed</td><td>Not assessed</td></tr>))}</tbody></table>)}
          </div>
          <div>
            <p className="font-medium mb-1">2. Not eligible</p>
            <table className="w-full"><tbody>{(d.groups ?? []).map((g: any) => (
              <tr key={g.stage11 + g.stage12} className="border-t border-border"><td>{LABEL[g.stage11] ?? g.stage11} — {g.stage12}</td><td className="text-right">{g.count}</td><td className="text-right">{formatUGX(Number(g.amount))}</td></tr>))}</tbody></table>
            <p className="text-muted-foreground mt-1">These are not correction candidates: their evidence did not establish a correction condition. Unresolved and Pending Evidence cases stay exactly as recorded.</p>
          </div>
        </>)}
      </CardContent>
    </Card>
  );
}
