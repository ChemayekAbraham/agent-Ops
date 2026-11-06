import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { useDeleteStandingOrder, type StandingOrderRow } from '@/hooks/useStandingOrders';

export function StandingOrderDeleteDialog({ order, onClose }: { order: StandingOrderRow; onClose: () => void }) {
  const del = useDeleteStandingOrder();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const trimmed = reason.trim();
  const valid = trimmed.length >= 10 && trimmed.length <= 1000;

  async function remove() {
    if (!valid || del.isPending) return;
    setError('');
    try {
      await del.mutateAsync({ order, reason: trimmed });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to delete this standing order.');
      setConfirming(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !del.isPending) onClose(); }}>
    <DialogContent className="max-w-md" onInteractOutside={(e) => { if (del.isPending) e.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>Delete standing order</DialogTitle>
        <DialogDescription>{order.target_name || 'Recipient'} · {formatUGX(Number(order.amount))} · {order.frequency}. This stops the schedule. Payments already made keep their records and are not changed.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <Textarea aria-label="Reason for deleting" placeholder="Why is this order being deleted? (at least 10 characters)" value={reason} minLength={10} maxLength={1000} disabled={confirming || del.isPending} onChange={(e) => setReason(e.target.value)} />
        {confirming && <p className="text-sm text-destructive">This cannot be undone. The order will have to be set up again to resume it.</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={del.isPending} onClick={() => (confirming ? setConfirming(false) : onClose())}>{confirming ? 'Back' : 'Cancel'}</Button>
          {confirming
            ? <Button variant="destructive" disabled={del.isPending} onClick={remove}>{del.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Trash2 className="h-4 w-4 mr-2" />}Confirm delete</Button>
            : <Button variant="destructive" disabled={!valid} onClick={() => setConfirming(true)}>Review delete</Button>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
