import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { coSupportErrorMessage } from '@/lib/coSupport';
import { useCoSupportStaffCancel, type CoSupportStaffCancelResult } from '@/hooks/useCoSupport';

/** Partner Ops "Cancel both halves" (server checks Partner Ops and landlord payment). */
export function CoSupportStaffCancel({ inviteId, kind }: { inviteId: string; kind: 'rent_plan' | 'house' }) {
  const cancel = useCoSupportStaffCancel();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [refunds, setRefunds] = useState<NonNullable<CoSupportStaffCancelResult['refunds_due']> | null>(null);
  const ok = reason.trim().length >= 10;

  const submit = () =>
    cancel.mutate(
      { inviteId, reason },
      {
        onSuccess: (data) => {
          setRefunds(data?.refunds_due ?? []);
          toast.success('Both halves cancelled.');
        },
        onError: (error) => toast.error(coSupportErrorMessage(error)),
      },
    );

  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>Cancel both halves</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setReason(''); setRefunds(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel both halves</DialogTitle>
            <DialogDescription>
              Both partners' halves are cancelled and the {kind === 'house' ? 'house' : 'Rent Plan'} goes back on the list.
            </DialogDescription>
          </DialogHeader>
          {refunds ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold">Refunds due (finance refunds them):</p>
              {refunds.length === 0 ? (
                <p className="text-sm text-muted-foreground">No refunds due.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {refunds.map((r) => (
                    <li key={r.commitment_id}>{r.partner_first_name ?? 'Partner'}: {formatUGX(Number(r.amount) || 0)}</li>
                  ))}
                </ul>
              )}
              <Button className="w-full" onClick={() => setOpen(false)}>Done</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (at least 10 characters)" />
              <Button className="w-full" variant="destructive" onClick={submit} disabled={!ok || cancel.isPending}>Cancel both halves</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
