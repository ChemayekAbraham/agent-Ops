import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { coSupportErrorMessage } from '@/lib/coSupport';

type Refund = { partner_first_name: string | null; amount: number };

/** Section 5: Partner Ops "Cancel both halves" (server checks Partner Ops and landlord payment). */
export function CoSupportStaffCancel({ inviteId }: { inviteId: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [refunds, setRefunds] = useState<Refund[] | null>(null);
  const ok = reason.trim().length >= 10;

  const submit = async () => {
    setBusy(true);
    // co_support_* functions are not in the generated types yet.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase.rpc as any)('co_support_staff_cancel', { p_invite_id: inviteId, p_reason: reason.trim() });
    setBusy(false);
    if (error) {
      toast.error(coSupportErrorMessage(error));
      return;
    }
    setRefunds(((data?.refunds_due as Refund[]) ?? []).map((r) => ({ partner_first_name: r.partner_first_name, amount: Number(r.amount) || 0 })));
    toast.success('Both halves cancelled.');
  };

  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>Cancel both halves</Button>
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setReason(''); setRefunds(null); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel both halves</DialogTitle>
            <DialogDescription>Both partners' halves are cancelled and the Rent Plan goes back on the list.</DialogDescription>
          </DialogHeader>
          {refunds ? (
            <div className="space-y-2">
              <p className="text-sm font-semibold">Refunds due (finance refunds them):</p>
              <ul className="space-y-1 text-sm">
                {refunds.map((r, i) => (
                  <li key={i}>{r.partner_first_name ?? 'Partner'}: {formatUGX(r.amount)}</li>
                ))}
              </ul>
              <Button className="w-full" onClick={() => setOpen(false)}>Done</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (at least 10 characters)" />
              <Button className="w-full" variant="destructive" onClick={submit} disabled={!ok || busy}>Cancel both halves</Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
