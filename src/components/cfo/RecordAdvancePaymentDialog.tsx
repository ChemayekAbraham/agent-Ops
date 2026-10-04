import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { toast } from 'sonner';

interface Props {
  advance: any | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}

export function RecordAdvancePaymentDialog({ advance, open, onOpenChange, onSuccess }: Props) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('mobile_money');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setAmount('');
      setMethod('mobile_money');
      setReference('');
      setNotes('');
    }
  }, [open]);

  if (!advance) return null;

  const outstanding = Number(advance.outstanding_balance);
  const parsed = Number(amount || 0);
  const valid = parsed > 0 && parsed <= outstanding && reference.trim().length > 0;

  const submit = async () => {
    if (!valid) {
      toast.error('Enter a valid amount');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error } = await supabase.functions.invoke('cfo-record-advance-payment', {
        body: {
          advance_id: advance.id,
          amount: parsed,
          payment_method: method,
          reference: reference.trim(),
          notes: notes || null,
        },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`Recorded ${formatUGX(parsed)} payment`);
      onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || 'Failed to record payment');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
          <DialogDescription>
            {advance.profiles?.full_name || 'Agent'} · Outstanding {formatUGX(outstanding)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div>
            <Label className="text-xs">Amount Paid (UGX)</Label>
            <Input
              type="number"
              placeholder="e.g. 100000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              max={outstanding}
            />
            <div className="flex gap-2 mt-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setAmount(String(outstanding))}>
                Full ({formatUGX(outstanding)})
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setAmount(String(Math.round(outstanding / 2)))}>
                Half
              </Button>
            </div>
          </div>

          <div>
            <Label className="text-xs">Payment Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="mobile_money">Mobile Money</SelectItem>
                <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="wallet_offset">Wallet Offset</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label className="text-xs">Reference / Transaction ID (required)</Label>
            <Input placeholder="e.g. MoMo TXN ID" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>

          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea placeholder="Context for audit log" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || submitting}>
            {submitting ? 'Recording...' : `Record ${parsed > 0 ? formatUGX(parsed) : 'Payment'}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}