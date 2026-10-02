import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { ShieldAlert, Lock } from 'lucide-react';
import { EvidenceReviewQueue } from './EvidenceReviewQueue';
import { CollectionReconciliationS11 } from './CollectionReconciliationS11';

type Bucket = { count: number; amount: number };
type Scenario = Record<string, number | string>;
type Summary = {
  total: Bucket & { indeterminate: number; unsupported: number };
  by_state: Record<string, Bucket>;
  by_classification: Record<string, Bucket>;
  by_priority: { group: number; count: number; amount: number; awaiting: number }[];
  scenarios: Scenario[];
  pending_approval: Record<string, number>;
  last_review_at: string | null;
};

const PRIORITY: Record<number, string> = {
  1: 'Completion-dependent',
  2: 'Other completed plans',
  3: 'Repaying plans',
  4: 'Did not change Rent Plan balance',
};
const SCEN: Record<string, string> = {
  A: 'A. Current records (no changes)',
  B: 'B. Remove Confirmed Duplicate only',
  C: 'C. Sensitivity only: Duplicate + all Unresolved',
};
const IMPACT: [string, string][] = [
  ['collections', 'Collections'],
  ['rent_plans', 'Rent Plans'],
  ['cash_in_transit', 'Cash in Transit'],
  ['rent_plan_repayment', 'Rent Plan repayment'],
  ['principal_recovered', 'Principal Recovered'],
  ['platform_fee', 'Platform Fee'],
  ['agent_commission', 'Agent commission exposure'],
  ['recruiter_commission', 'Recruiter commission exposure'],
];
const fmt = (k: string, v: unknown) =>
  k === 'collections' || k === 'rent_plans' ? Number(v ?? 0).toLocaleString() : formatUGX(Number(v ?? 0));

export function CorrectionCenterPanel() {
  const qc = useQueryClient();
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [details, setDetails] = useState(false);
  const [busy, setBusy] = useState(false);

  const summary = useQuery({
    queryKey: ['cfo-correction-center'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('cfo_correction_center_summary');
      if (error) throw error;
      return data as unknown as Summary;
    },
  });
  const history = useQuery({
    queryKey: ['cfo-correction-batches'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_correction_approval_batches')
        .select('id,batch_ref,collection_count,amount,status,decided_by,decided_at,decision_note,execution_status')
        .order('decided_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  if (summary.isLoading) return <p className="text-sm text-muted-foreground">Loading Correction Center…</p>;
  if (summary.error || !summary.data)
    return <p className="text-sm text-destructive">Could not load the Correction Center. {(summary.error as Error)?.message}</p>;

  const s = summary.data;
  const cls = (k: string) => s.by_classification[k] ?? { count: 0, amount: 0 };
  const pending = s.pending_approval;
  const pendingCount = Number(pending.count ?? 0);
  const states = ['Evidence not requested', 'Evidence requested', 'Evidence received'];

  const submit = async () => {
    if (!decision) return;
    setBusy(true);
    const { error } = await supabase.rpc('cfo_prepare_correction_decision', { p_decision: decision, p_note: note });
    setBusy(false);
    if (error) return toast.error(error.message);
    toast.success(decision === 'approve' ? 'Approval recorded. Nothing has been executed.' : 'Rejection recorded.');
    setDecision(null);
    setNote('');
    qc.invalidateQueries({ queryKey: ['cfo-correction-center'] });
    qc.invalidateQueries({ queryKey: ['cfo-correction-batches'] });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Corrections & Approvals</h1>
        <p className="text-sm text-muted-foreground">
          {s.total.count.toLocaleString()} collections — {formatUGX(s.total.amount)} —{' '}
          {cls('Confirmed Duplicate').count} Confirmed Duplicate —{' '}
          {pendingCount === 0 ? 'No correction pending approval.' : `${pendingCount} collections pending approval.`}
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3 text-sm">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          No financial correction has been executed. Evidence classification is not an accounting approval, and
          execution is not available on this page.
        </span>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">1. Pending Evidence Reviews</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {['Confirmed Genuine', 'Confirmed Duplicate', 'Unresolved'].map((k) => (
              <div key={k} className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">{k}</p>
                <p className="text-lg font-semibold">{cls(k).count.toLocaleString()}</p>
                <p className="text-sm">{formatUGX(cls(k).amount)}</p>
              </div>
            ))}
          </div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th>Priority</th><th className="text-right">Collections</th><th className="text-right">Amount</th><th className="text-right">Awaiting evidence</th></tr></thead>
            <tbody>
              {[1, 2, 3, 4].map((g) => {
                const p = s.by_priority.find((x) => x.group === g) ?? { count: 0, amount: 0, awaiting: 0 };
                return (
                  <tr key={g} className="border-t border-border">
                    <td className="py-1">{g}. {PRIORITY[g]}</td>
                    <td className="text-right">{p.count}</td><td className="text-right">{formatUGX(p.amount)}</td><td className="text-right">{p.awaiting}</td>
                  </tr>
                );
              })}
              <tr className="border-t border-border font-semibold"><td className="py-1">Total</td><td className="text-right">{s.total.count}</td><td className="text-right">{formatUGX(s.total.amount)}</td><td /></tr>
            </tbody>
          </table>
          <p className="text-xs text-muted-foreground">
            Evidence states: {states.map((k) => `${k} ${s.by_state[k]?.count ?? 0}`).join(' · ')}. Original classification: {s.total.indeterminate} Indeterminate / {s.total.unsupported} Unsupported (never overwritten).
          </p>
          <EvidenceReviewQueue />
        </CardContent>
      </Card>

      <CollectionReconciliationS11 />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">2. Correction Simulations</CardTitle>
          <Badge variant="outline">Simulated / Not Posted</Badge>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted-foreground"><th>Measure</th>{s.scenarios.map((x) => <th key={String(x.scenario)} className="text-right">{SCEN[String(x.scenario)]}</th>)}</tr></thead>
            <tbody>
              {[...IMPACT.slice(0, 5), ['access_fee', 'Access Fee'] as [string, string], ['registration_fee', 'Registration Fee'] as [string, string], ...IMPACT.slice(5)].map(([k, l]) => (
                <tr key={k} className="border-t border-border"><td className="py-1">{l}</td>{s.scenarios.map((x) => <td key={String(x.scenario)} className="text-right">{fmt(k, x[k])}</td>)}</tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">Partner Returns impact UGX 0. Rows are different views of the same collections and must not be added together. Commission is exposure only; no recovery is assumed.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">3. Pending CFO Approval</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {pendingCount === 0 ? (
            <p className="text-sm text-muted-foreground">No correction pending approval. Only collections Finance classifies as Confirmed Duplicate appear here.</p>
          ) : (
            <div className="text-sm">{pendingCount} Confirmed Duplicate collections — {formatUGX(Number(pending.amount))}</div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={pendingCount === 0} onClick={() => setDetails(true)}>Review Details</Button>
            <Button size="sm" disabled={pendingCount === 0} onClick={() => setDecision('approve')}>Approve</Button>
            <Button variant="outline" size="sm" disabled={pendingCount === 0} onClick={() => setDecision('reject')}>Reject</Button>
            <Button variant="secondary" size="sm" disabled><Lock className="mr-1 h-3 w-3" />Execute correction (not available)</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">4. Approved / Executed History</CardTitle></CardHeader>
        <CardContent>
          {(history.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No approval decisions recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="text-left text-muted-foreground"><th>Batch</th><th>Status</th><th>Decided</th><th className="text-right">Collections</th><th className="text-right">Amount</th><th>Execution</th></tr></thead>
              <tbody>
                {history.data!.map((b) => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="py-1">{b.batch_ref}</td>
                    <td>{b.status === 'approval_prepared' ? 'Approval prepared' : 'Rejected'}</td>
                    <td>{new Date(b.decided_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })}</td>
                    <td className="text-right">{b.collection_count}</td>
                    <td className="text-right">{formatUGX(Number(b.amount))}</td>
                    <td>Not executed</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={details} onOpenChange={setDetails}>
        <DialogContent>
          <DialogHeader><DialogTitle>Proposed accounting impact (Simulated / Not Posted)</DialogTitle></DialogHeader>
          <table className="w-full text-sm"><tbody>
            {[['count', 'Collections'] as [string, string], ['amount', 'Collection amount'] as [string, string], ...IMPACT.slice(1)].map(([k, l]) => (
              <tr key={k} className="border-t border-border"><td className="py-1">{l}</td><td className="text-right">{fmt(k === 'count' ? 'collections' : k, pending[k])}</td></tr>
            ))}
          </tbody></table>
        </DialogContent>
      </Dialog>

      <Dialog open={decision !== null} onOpenChange={(o) => !o && setDecision(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{decision === 'approve' ? 'Record approval' : 'Record rejection'}</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">This records your decision only. It does not reverse collections or change any balance.</p>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (at least 10 characters)" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecision(null)}>Cancel</Button>
            <Button disabled={busy || note.trim().length < 10} onClick={submit}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
