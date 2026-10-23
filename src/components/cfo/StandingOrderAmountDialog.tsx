import { useState } from 'react';
import { Minus, Plus, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { useStandingOrderAmount } from '@/hooks/useStandingOrderAmount';
import type { StandingOrderRow } from '@/hooks/useStandingOrders';

export function StandingOrderAmountDialog({ order, onClose, previewOnly = false }: { order: StandingOrderRow; onClose: () => void; previewOnly?: boolean }) {
  const edit = useStandingOrderAmount();
  const [direction, setDirection] = useState<'increase' | 'decrease'>('increase');
  const [delta, setDelta] = useState('');
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  const [savedAmount, setSavedAmount] = useState<number | null>(null);
  const difference = (direction === 'increase' ? 1 : -1) * Number(delta);
  const newAmount = Number(order.amount) + difference;
  const valid = Number.isFinite(newAmount) && Number.isFinite(Number(delta)) && Number(delta) > 0
    && newAmount > 0 && newAmount <= 500000000 && reason.trim().length >= 10 && reason.trim().length <= 1000;

  async function save() {
    if (previewOnly || !valid || !confirming || edit.isPending) return;
    setError('');
    try {
      const result = await edit.mutateAsync({ order, newAmount, reason });
      setSavedAmount(result.order.amount);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unable to save the revised amount.');
      setConfirming(false);
    }
  }

  return <Dialog open onOpenChange={(open) => { if (!open && !edit.isPending) onClose(); }}>
    <DialogContent className="max-w-md" onInteractOutside={(e) => { if (edit.isPending) e.preventDefault(); }}>
      <DialogHeader>
        <DialogTitle>{savedAmount !== null ? 'Standing order amount updated' : 'Change standing order amount'}</DialogTitle>
        <DialogDescription>{order.target_name || 'Recipient'} · Future scheduled payments only. Saving does not run a payment or change the schedule.</DialogDescription>
      </DialogHeader>
      {previewOnly && <p role="note" className="text-sm text-muted-foreground">Preview only. Saving is disabled pending separate approval. Your standing order will not change.</p>}
      {savedAmount !== null ? <>
        <p className="text-lg font-semibold text-primary" role="status">Updated amount: {formatUGX(savedAmount)}</p>
        <Button onClick={onClose}>Done</Button>
      </> : <>
        <div className="flex gap-2" role="group" aria-label="Amount change direction">
          <Button variant={direction === 'increase' ? 'default' : 'outline'} disabled={confirming || edit.isPending} onClick={() => setDirection('increase')}><Plus className="mr-2 h-4 w-4" />Increase</Button>
          <Button variant={direction === 'decrease' ? 'default' : 'outline'} disabled={confirming || edit.isPending} onClick={() => setDirection('decrease')}><Minus className="mr-2 h-4 w-4" />Decrease</Button>
        </div>
        <label className="space-y-2 text-sm">{direction === 'increase' ? 'Increase by (UGX)' : 'Decrease by (UGX)'}
          <Input aria-label="Change amount (UGX)" type="number" min="0" step="any" value={delta} disabled={confirming || edit.isPending} onChange={(e) => setDelta(e.target.value)} />
        </label>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-muted-foreground">Current amount</dt><dd>{formatUGX(order.amount)}</dd>
          <dt className="text-muted-foreground">Proposed amount</dt><dd>{Number.isFinite(newAmount) ? formatUGX(newAmount) : '—'}</dd>
          <dt className="text-muted-foreground">Difference</dt><dd>{Number.isFinite(difference) ? `${difference > 0 ? '+' : difference < 0 ? '−' : ''}${formatUGX(Math.abs(difference))}` : '—'}</dd>
        </dl>
        <label className="space-y-2 text-sm">Reason for change
          <Textarea aria-label="Reason for change" minLength={10} maxLength={1000} value={reason} disabled={confirming || edit.isPending} onChange={(e) => setReason(e.target.value)} />
        </label>
        {!valid && <p className="text-sm text-muted-foreground">Enter a positive change, a resulting amount up to UGX 500,000,000, and a reason of at least 10 characters.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {confirming && <p className="text-sm font-medium">Confirm {formatUGX(order.amount)} → {formatUGX(newAmount)}? An in-progress payment may use its previously captured amount.</p>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={edit.isPending} onClick={() => confirming ? setConfirming(false) : onClose()}>{confirming ? 'Back' : 'Cancel'}</Button>
          {confirming ? <Button disabled={previewOnly || !valid || edit.isPending} onClick={save}>{edit.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{previewOnly ? 'Saving disabled' : 'Confirm amount change'}</Button>
            : <Button disabled={!valid} onClick={() => setConfirming(true)}>Review change</Button>}
        </div>
      </>}
    </DialogContent>
  </Dialog>;
}