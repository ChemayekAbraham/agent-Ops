import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, Save } from 'lucide-react';
import { calculateRentRepayment } from '@/lib/rentCalculations';
import { GuarantorConsentCheckbox } from '@/components/agent/GuarantorConsentCheckbox';


interface EditableRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  access_fee?: number;
  request_fee?: number;
  total_repayment?: number;
  daily_repayment?: number;
  number_of_payments?: number | null;
  amount_repaid?: number;
}

interface EditApprovedRentDialogProps {
  request: EditableRequest | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EditApprovedRentDialog({ request, open, onOpenChange, onSaved }: EditApprovedRentDialogProps) {
  const [rentAmount, setRentAmount] = useState<string>('');
  const [durationDays, setDurationDays] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [guarantorConsent, setGuarantorConsent] = useState(false);

  const handleOpen = (isOpen: boolean) => {
    if (isOpen && request) {
      setRentAmount(String(request.rent_amount || 0));
      setDurationDays(String(request.duration_days || 0));
      setGuarantorConsent(false);
    }
    onOpenChange(isOpen);
  };

  const handleSave = async () => {
    if (!request) return;
    const amount = Number(rentAmount);
    const days = Number(durationDays);
    if (!amount || amount <= 0) { toast.error('Rent amount must be positive'); return; }
    if (!days || days <= 0) { toast.error('Duration must be positive'); return; }

    const calc = calculateRentRepayment(amount, days);
    const repaid = Number(request.amount_repaid || 0);
    if (repaid > calc.totalRepayment) {
      toast.error(`Cannot lower below repaid amount (UGX ${repaid.toLocaleString()})`);
      return;
    }
    if (!guarantorConsent) {
      toast.error('You must re-accept guarantor responsibility before saving changes');
      return;
    }

    setSaving(true);
    const { error } = await supabase
      .from('rent_requests')
      .update({
        rent_amount: amount,
        duration_days: days,
        access_fee: calc.accessFee,
        request_fee: calc.requestFee,
        total_repayment: calc.totalRepayment,
        daily_repayment: calc.dailyRepayment,
        agent_guarantor_consent: true,
        agent_guarantor_consent_at: new Date().toISOString(),
        agent_guarantor_consent_version: 'v1',
      })
      .eq('id', request.id);

    setSaving(false);

    if (error) {
      console.error('Rent request update error:', error);
      toast.error('Failed to update: ' + (error.message || error.code || 'Unknown error'));
    } else {
      toast.success(`Rent updated — daily charge UGX ${calc.dailyRepayment.toLocaleString()}`);
      onOpenChange(false);
      onSaved();
    }
  };

  const amountNum = Number(rentAmount) || 0;
  const daysNum = Number(durationDays) || 0;
  const preview = amountNum > 0 && daysNum > 0 ? calculateRentRepayment(amountNum, daysNum) : null;

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">Edit Approved Rent Request</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs font-medium">Rent Amount (UGX)</Label>
            <Input type="number" inputMode="numeric" value={rentAmount} onChange={e => setRentAmount(e.target.value)} className="h-9" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs font-medium">Duration (Days)</Label>
            <Input type="number" inputMode="numeric" value={durationDays} onChange={e => setDurationDays(e.target.value)} className="h-9" />
          </div>
          {preview && (
            <div className="rounded-md bg-muted/50 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">Access Fee</span><span>UGX {preview.accessFee.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Request Fee</span><span>UGX {preview.requestFee.toLocaleString()}</span></div>
              <div className="flex justify-between font-semibold border-t border-border/40 pt-1"><span>Total Repayment</span><span>UGX {preview.totalRepayment.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Daily Repayment</span><span>UGX {preview.dailyRepayment.toLocaleString()}</span></div>
            </div>
          )}

          <GuarantorConsentCheckbox
            checked={guarantorConsent}
            onCheckedChange={setGuarantorConsent}
          />
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !guarantorConsent}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
