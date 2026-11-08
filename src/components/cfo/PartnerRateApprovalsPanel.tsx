import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Check, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAuth } from '@/hooks/useAuth';
import {
  PARTNER_RATE_DECIDER_ROLE, partnerRateErrorText, useDecidePartnerRateRequests, usePartnerRateRequests,
  type PartnerRateDecisionResult, type PartnerRateRequestRow, type PartnerRateRequestStage, type PartnerRateRequestStatus,
} from '@/hooks/usePartnerRateApprovals';
import { formatRatePct } from '@/lib/partnerReturnPolicy';
import { formatUGX } from '@/lib/rentCalculations';

type View = PartnerRateRequestStage;

/** Each view is one list_portfolio_rate_requests call; the two approved views share the 'approved' call. */
const VIEWS: { id: View; label: string; status: PartnerRateRequestStatus }[] = [
  { id: 'pending', label: 'Pending', status: 'pending' },
  { id: 'approved_next_cycle', label: 'Approved – next cycle', status: 'approved' },
  { id: 'applied', label: 'Applied', status: 'approved' },
  { id: 'rejected', label: 'Rejected', status: 'rejected' },
  { id: 'superseded', label: 'Superseded', status: 'superseded' },
];

const STAGE_LABEL: Record<PartnerRateRequestStage, string> = {
  pending: 'Pending',
  approved_next_cycle: 'Approved – next cycle',
  applied: 'Applied',
  rejected: 'Rejected',
  superseded: 'Superseded',
};

const SOURCE_LABEL: Record<PartnerRateRequestRow['source'], string> = {
  new_portfolio: 'New portfolio',
  rate_change: 'Rate change',
};

const when = (iso: string | null) => (iso ? format(new Date(iso), 'd MMM yyyy, HH:mm') : '—');
const pct = (v: number | null | undefined) => (v == null ? '—' : formatRatePct(Number(v)));

/**
 * CFO queue for partner Returns rates that differ from the standard rate (portfolio_rate_approvals).
 * Approve or reject in batches: one cfo_decide_portfolio_rate_requests call per batch.
 * An approved rate applies from the NEXT cycle (after the current cycle's Returns event, or at
 * once when approved within 10 days after the last payout). Only the CFO can decide;
 * CEO, COO, Super Admin and Partner Ops can read the queue.
 */
export function PartnerRateApprovalsPanel() {
  const { enabledRoles } = useAuth();
  const canDecide = (enabledRoles ?? []).includes(PARTNER_RATE_DECIDER_ROLE);
  const [view, setView] = useState<View>('pending');
  const viewDef = VIEWS.find((v) => v.id === view) ?? VIEWS[0];
  const requests = usePartnerRateRequests(viewDef.status);
  const decide = useDecidePartnerRateRequests();

  const rows = useMemo(
    () => (requests.data ?? []).filter((r) => r.stage === view),
    [requests.data, view],
  );
  const pendingView = view === 'pending';
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const selectedIds = rows.filter((r) => selected.has(r.request_id)).map((r) => r.request_id);
  const [decision, setDecision] = useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<PartnerRateDecisionResult | null>(null);

  const toggle = (id: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const begin = (type: 'approve' | 'reject') => { setDecision(type); setNote(''); setError(null); };
  const closeDialog = () => { if (!decide.isPending) { setDecision(null); setError(null); } };

  const submit = async () => {
    if (!decision || selectedIds.length === 0) return;
    if (decision === 'reject' && !note.trim()) { setError('A reason is required to reject.'); return; }
    setError(null);
    try {
      const result = await decide.mutateAsync({ requestIds: selectedIds, decision, note });
      setLastResult(result);
      const verb = decision === 'approve' ? 'approved' : 'rejected';
      toast.success(`${result.decided} request(s) ${verb}`, {
        description: [
          result.skipped ? `${result.skipped} skipped (already decided).` : null,
          decision === 'approve' ? 'Approved rates apply from the next cycle.' : null,
        ].filter(Boolean).join(' ') || undefined,
      });
      setSelected(new Set());
      setDecision(null);
      setNote('');
    } catch (e) {
      setError(partnerRateErrorText(e));
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <ShieldCheck className="h-5 w-5 text-primary" /> Partner Returns rate approvals
        </h2>
        <p className="text-sm text-muted-foreground">
          Rates staff typed that differ from the standard rate. Until you approve, a new portfolio earns the standard rate
          and an edited one keeps its rate. An approved rate applies from the next cycle.
        </p>
      </div>

      <Tabs value={view} onValueChange={(v) => { setView(v as View); setSelected(new Set()); }}>
        <TabsList className="h-auto flex-wrap">
          {VIEWS.map((v) => <TabsTrigger key={v.id} value={v.id}>{v.label}</TabsTrigger>)}
        </TabsList>
      </Tabs>

      {lastResult && (
        <p role="status" className="text-sm text-muted-foreground">
          Last decision: {lastResult.decided} {lastResult.decision === 'rejected' ? 'rejected' : 'approved'}
          {lastResult.skipped ? `, ${lastResult.skipped} skipped (already decided)` : ''}
          {lastResult.decision === 'approved' ? '. Approved rates apply from the next cycle.' : '.'}
        </p>
      )}

      {pendingView && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm">
            <Checkbox
              aria-label="Select all rate requests"
              checked={selectedIds.length === rows.length ? true : selectedIds.length ? 'indeterminate' : false}
              onCheckedChange={(c) => setSelected(c === true ? new Set(rows.map((r) => r.request_id)) : new Set())}
              disabled={!canDecide || decide.isPending}
            />
            Select all ({selectedIds.length})
          </label>
          <Button className="gap-2" disabled={!canDecide || !selectedIds.length || decide.isPending} onClick={() => begin('approve')}>
            <Check className="h-4 w-4" /> Approve selected
          </Button>
          <Button variant="outline" disabled={!canDecide || !selectedIds.length || decide.isPending} onClick={() => begin('reject')}>
            Reject selected
          </Button>
          {!canDecide && <span className="text-xs text-muted-foreground">Only the CFO can approve or reject.</span>}
        </div>
      )}

      {requests.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading rate requests…</p>
      ) : requests.isError ? (
        <div role="alert" className="space-y-2">
          <p className="text-sm text-destructive">{partnerRateErrorText(requests.error)}</p>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => void requests.refetch()}>
            <RotateCcw className="h-4 w-4" /> Retry
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No {STAGE_LABEL[view].toLowerCase()} rate requests.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                {pendingView && <TableHead className="w-10"><span className="sr-only">Select</span></TableHead>}
                <TableHead>Partner</TableHead>
                <TableHead>Portfolio</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Requested rate</TableHead>
                <TableHead>Requested by</TableHead>
                <TableHead>Stage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.request_id}>
                  {pendingView && (
                    <TableCell>
                      <Checkbox
                        aria-label={`Select ${r.portfolio_code ?? r.partner_name ?? 'request'}`}
                        checked={selected.has(r.request_id)}
                        disabled={!canDecide || decide.isPending}
                        onCheckedChange={(c) => toggle(r.request_id, c === true)}
                      />
                    </TableCell>
                  )}
                  <TableCell className="min-w-[8rem]">{r.partner_name || '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{r.portfolio_code || '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.investment_amount == null ? '—' : formatUGX(Number(r.investment_amount))}</TableCell>
                  <TableCell>{SOURCE_LABEL[r.source] ?? r.source}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <strong>{pct(r.requested_rate)}</strong>
                    <span className="text-xs text-muted-foreground"> · in force {pct(r.rate_in_force)}</span>
                    {r.current_rate != null && Number(r.current_rate) !== Number(r.rate_in_force) && (
                      <span className="block text-xs text-muted-foreground">now {pct(r.current_rate)}</span>
                    )}
                    {r.requested_rate != null && r.standard_rate != null && Number(r.requested_rate) < Number(r.standard_rate) && (
                      <Badge variant="outline" className="mt-1 flex w-fit border-amber-500/50 text-amber-700 dark:text-amber-400">
                        lower than this person&apos;s rate
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="min-w-[8rem]">
                    <span className="block">{r.requested_by_name || '—'}</span>
                    <span className="block text-xs text-muted-foreground">{when(r.requested_at)}</span>
                  </TableCell>
                  <TableCell className="min-w-[8rem]">
                    <Badge variant={r.stage === 'pending' ? 'secondary' : r.stage === 'rejected' ? 'destructive' : 'outline'}>
                      {STAGE_LABEL[r.stage] ?? r.stage}
                    </Badge>
                    {r.decided_at && <span className="block text-xs text-muted-foreground">{when(r.decided_at)}</span>}
                    {r.applied_at && <span className="block text-xs text-muted-foreground">Applied {when(r.applied_at)}</span>}
                    {r.decision_note && <span className="block text-xs text-muted-foreground break-words">{r.decision_note}</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={decision != null} onOpenChange={(open) => { if (!open) closeDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{decision === 'reject' ? 'Reject rate requests' : 'Approve rate requests'}</DialogTitle>
            <DialogDescription>
              {selectedIds.length} request(s).{' '}
              {decision === 'approve'
                ? 'Each approved rate applies from the portfolio’s next cycle; the current cycle is paid at the rate in force.'
                : 'Rejected portfolios keep the rate in force.'}
            </DialogDescription>
          </DialogHeader>
          <Label htmlFor="partner-rate-decision-note">{decision === 'reject' ? 'Reason (required)' : 'Note (optional)'}</Label>
          <Textarea
            id="partner-rate-decision-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            disabled={decide.isPending}
          />
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={decide.isPending} onClick={closeDialog}>Cancel</Button>
            <Button
              variant={decision === 'reject' ? 'destructive' : 'default'}
              disabled={decide.isPending || (decision === 'reject' && !note.trim())}
              onClick={() => void submit()}
            >
              {decide.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {decision === 'reject' ? 'Reject requests' : 'Approve requests'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

export default PartnerRateApprovalsPanel;
