import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';
import { useQueryClient } from '@tanstack/react-query';
import { Zap } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  advance: {
    id: string;
    principal: number;
    outstanding_balance: number;
    cycle_days?: number;
    access_fee?: number;
  };
}

export function VoluntaryRepayAdvanceDialog({ open, onOpenChange, advance }: Props) {
  const qc = useQueryClient();
  const cycleDays = Number(advance.cycle_days) || 30;
  const totalPayable = Number(advance.principal) + Number(advance.access_fee || 0);
  const scheduledDaily = cycleDays > 0 ? Math.round(totalPayable / cycleDays) : 0;

  const [daysAhead, setDaysAhead] = useState<number>(2);
  const [submitting, setSubmitting] = useState(false);

  const amount = Math.min(scheduledDaily * daysAhead, Number(advance.outstanding_balance));

  const submit = async () => {
    if (daysAhead <= 0) {
      toast.error('Enter at least 1 day');
      return;
    }
    setSubmitting(true);
    const { data, error } = await invokeEdgeFunction<any>('voluntary-repay-advance', {
      body: { advance_id: advance.id, days_ahead: daysAhead },
      errorTitle: 'Payment failed',
    });
    setSubmitting(false);
    if (error) return;
    toast.success('Advance payment recorded', {
      description: `${formatUGX(data?.amount_paid ?? amount)} deducted. Next ${daysAhead} daily deduction${daysAhead === 1 ? '' : 's'} skipped.`,
    });
    qc.invalidateQueries({ queryKey: ['my-issued-advances'] });
    qc.invalidateQueries({ queryKey: ['agent-balances'] });
    qc.invalidateQueries({ queryKey: ['user-available-balance'] });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-primary" /> Pay Ahead
          </DialogTitle>
          <DialogDescription>
            Pay a few days ahead. Money is deducted now from your withdrawable wallet, and the next N daily deductions are skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-1">
            <div className="flex justify-between"><span className="text-muted-foreground">Scheduled daily</span><span className="font-bold tabular-nums">{formatUGX(scheduledDaily)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Outstanding</span><span className="font-bold tabular-nums">{formatUGX(advance.outstanding_balance)}</span></div>
          </div>
          <div>
            <Label htmlFor="days-ahead" className="text-xs">Days to pay ahead</Label>
            <Input
              id="days-ahead"
              type="number"
              min={1}
              max={cycleDays}
              value={daysAhead}
              onChange={(e) => setDaysAhead(Math.max(1, parseInt(e.target.value || '1', 10)))}
            />
          </div>
          <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
            <p className="text-[10px] uppercase tracking-wide font-bold text-muted-foreground">You will be charged now</p>
            <p className="text-xl font-black tabular-nums text-primary">{formatUGX(amount)}</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || amount <= 0}>
            {submitting ? 'Processing…' : `Pay ${formatUGX(amount)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}