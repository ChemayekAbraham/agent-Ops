import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { useCfoApprovalAuthority } from '@/hooks/useCfoApprovalAuthority';
import {
  COMPOUND_REQUEST_MIN_REASON, useCompoundRequests, useDecideCompoundRequest, type CompoundRequestRow,
} from '@/hooks/useCompoundReversal';
import { CompoundRequestsTable } from '@/components/executive/partner-ops/CompoundRequestsPanel';

export function CompoundRequestApprovalsPanel() {
  const requests = useCompoundRequests();
  const decide = useDecideCompoundRequest();
  const { canApprove } = useCfoApprovalAuthority();
  const [active, setActive] = useState<{ row: CompoundRequestRow; approve: boolean } | null>(null);
  const [note, setNote] = useState('');

  const confirm = async () => {
    if (!active) return;
    try {
      await decide.mutateAsync({ requestId: active.row.id, approve: active.approve, note });
      toast.success(active.approve ? 'Approved — the Return is back in Nearing Payout' : 'Request rejected');
      setActive(null); setNote('');
    } catch (e: any) { toast.error(e?.message || 'Could not record the decision'); }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Compound Requests</h2>
        <p className="text-sm text-muted-foreground">
          Partner Ops requests to take a reinvested Return back out of a portfolio so it is paid as cash through
          Nearing Payout. Approving does not credit any wallet.
        </p>
      </div>
      <CompoundRequestsTable
        rows={requests.data} loading={requests.isLoading} error={requests.error as Error | null}
        actions={(r) => r.status === 'pending_cfo' && canApprove ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setActive({ row: r, approve: true })}>Approve</Button>
            <Button size="sm" variant="outline" onClick={() => setActive({ row: r, approve: false })}>Reject</Button>
          </div>
        ) : null}
      />

      <Dialog open={!!active} onOpenChange={(o) => { if (!o) { setActive(null); setNote(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{active?.approve ? 'Approve compound request' : 'Reject compound request'}</DialogTitle>
            <DialogDescription>
              {active && (active.approve
                ? `${formatUGX(Number(active.row.amount))} will be taken out of ${active.row.portfolio_code} (principal now ${formatUGX(Number(active.row.current_principal))}) and the Return returns to Nearing Payout. ${active.row.requested_by_name ?? 'The requester'} then has 24 hours to queue the payout.`
                : `The reinvestment for ${active.row.partner_name} stays in the portfolio.`)}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note for the records" />
          <p className="text-xs text-muted-foreground">At least {COMPOUND_REQUEST_MIN_REASON} characters.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActive(null)}>Cancel</Button>
            <Button onClick={confirm} disabled={decide.isPending || note.trim().length < COMPOUND_REQUEST_MIN_REASON}
              variant={active?.approve ? 'default' : 'destructive'}>
              {decide.isPending ? 'Saving…' : active?.approve ? 'Approve' : 'Reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
