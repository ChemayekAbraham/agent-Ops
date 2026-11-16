import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/sonner';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import { useAuthoriseReturnCycleOverride, RETURN_OVERRIDE_MIN_REASON } from '@/hooks/useReturnCycleOverride';
import { useAuth } from '@/hooks/useAuth';
import { format } from 'date-fns';

export interface AuthoriseExtraPaymentTarget {
  portfolioId: string;
  portfolioName: string;
  partnerName: string;
  /** The card's next payout date. */
  nextPayoutDate: string;
  investmentAmount: number;
  roiPercentage: number | null;
}

export function AuthoriseExtraPaymentDialog({ target, onOpenChange, onDone }: {
  target: AuthoriseExtraPaymentTarget | null;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}) {
  const { user } = useAuth();
  const mutation = useAuthoriseReturnCycleOverride();
  const [staff, setStaff] = useState<UserResult | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');

  const oneCycle = target && target.roiPercentage != null
    ? Math.round(target.investmentAmount * target.roiPercentage / 100) : 0;

  useEffect(() => {
    if (target) { setStaff(null); setReason(''); setAmount(oneCycle > 0 ? String(oneCycle) : ''); }
  }, [target?.portfolioId, target?.nextPayoutDate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!target) return null;
  const d = new Date(target.nextPayoutDate);
  const cycleDate = format(d, 'yyyy-MM-dd');
  const amt = Number(amount);
  const isSelf = !!staff && staff.id === user?.id;
  const problem = !staff ? 'Choose the staff member who will make the payment'
    : isSelf ? 'The staff member cannot be you'
    : !Number.isInteger(amt) || amt <= 0 ? 'Enter the maximum amount in whole UGX'
    : reason.trim().length < RETURN_OVERRIDE_MIN_REASON ? `Give a reason of at least ${RETURN_OVERRIDE_MIN_REASON} characters`
    : null;

  const submit = () => {
    if (problem || !staff) return;
    mutation.mutate(
      { portfolioId: target.portfolioId, cycleDate, requesterId: staff.id, maxAmount: amt, reason },
      {
        onSuccess: () => {
          toast.success(`Permission given. ${staff.full_name} can now pay this cycle once, within 24 hours`);
          onOpenChange(false);
          onDone?.();
        },
        onError: (e) => toast.error((e as Error)?.message || 'Could not give permission'),
      },
    );
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Authorise extra payment</DialogTitle>
          <DialogDescription>One extra Rent profit share payment for this portfolio's cycle. Single use, valid for 24 hours.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div><Label className="text-xs text-muted-foreground">Portfolio</Label><p className="font-semibold">{target.portfolioName}</p><p className="text-xs text-muted-foreground">{target.partnerName}</p></div>
            <div><Label className="text-xs text-muted-foreground">Cycle month</Label><p className="font-semibold">{format(d, 'MMMM yyyy')}</p><p className="text-xs text-muted-foreground">Payout date {format(d, 'd MMM yyyy')}</p></div>
          </div>
          <UserSearchPicker label="Staff member who will make the payment" selectedUser={staff} onSelect={setStaff} />
          {isSelf && <p className="text-xs text-destructive">The staff member cannot be you.</p>}
          <div className="space-y-1">
            <Label htmlFor="extra-max">Maximum amount (UGX)</Label>
            <Input id="extra-max" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            <p className="text-[11px] text-muted-foreground">Defaults to one cycle's Rent profit share.</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="extra-reason">Reason</Label>
            <Textarea id="extra-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`At least ${RETURN_OVERRIDE_MIN_REASON} characters`} />
            <p className="text-[11px] text-muted-foreground">{reason.trim().length}/{RETURN_OVERRIDE_MIN_REASON}</p>
          </div>
          {problem && staff && <p className="text-xs text-destructive">{problem}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!!problem || mutation.isPending}>{mutation.isPending ? 'Saving…' : 'Give permission'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
