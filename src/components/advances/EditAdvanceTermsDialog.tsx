import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Pencil } from 'lucide-react';
import {
  formatUGX, calculateAccessFee, installmentCount, frequencyLabel,
  REPAYMENT_FREQUENCIES, type RepaymentFrequency,
} from '@/lib/agentAdvanceCalculations';

const MIN_REASON = 10;

export interface EditableAdvance {
  id: string;
  principal: number;
  access_fee?: number | null;
  outstanding_balance: number;
  cycle_days: number;
  monthly_rate?: number | null;
  repayment_frequency?: string | null;
  agent_name?: string | null;
}

interface Props {
  advance: EditableAdvance | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: () => void;
}

/**
 * Lets the CFO / Agent Ops re-term an existing advance: custom monthly rate,
 * term length and repayment frequency. Money already repaid is preserved —
 * only the fee, total and outstanding are recomputed server-side.
 */
export function EditAdvanceTermsDialog({ advance, open, onOpenChange, onSaved }: Props) {
  const queryClient = useQueryClient();
  const [rate, setRate] = useState('33');
  const [cycleDays, setCycleDays] = useState('30');
  const [frequency, setFrequency] = useState<RepaymentFrequency>('daily');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!advance) return;
    setRate(String(Math.round((Number(advance.monthly_rate ?? 0.33) || 0.33) * 10000) / 100));
    setCycleDays(String(advance.cycle_days || 30));
    setFrequency(((advance.repayment_frequency as RepaymentFrequency) || 'daily'));
    setReason('');
  }, [advance?.id, open]);

  const ratePct = Number(rate);
  const rateValid = Number.isFinite(ratePct) && ratePct >= 0 && ratePct <= 100;
  const days = Number(cycleDays);
  const daysValid = Number.isFinite(days) && days >= 1 && days <= 365;

  const preview = useMemo(() => {
    if (!advance || !rateValid || !daysValid) return null;
    const principal = Number(advance.principal || 0);
    const oldTotal = principal + Number(advance.access_fee || 0);
    const paid = Math.max(0, oldTotal - Number(advance.outstanding_balance || 0));
    const newFee = calculateAccessFee(principal, days, ratePct / 100);
    const newTotal = principal + newFee;
    const count = installmentCount(days, frequency);
    return {
      newFee,
      newTotal,
      paid,
      newOutstanding: Math.max(0, newTotal - paid),
      count,
      installment: Math.ceil(newTotal / count),
    };
  }, [advance, ratePct, rateValid, days, daysValid, frequency]);

  const canSave = !!advance && rateValid && daysValid && reason.trim().length >= MIN_REASON && !saving;

  const handleSave = async () => {
    if (!canSave || !advance) return;
    setSaving(true);
    try {
      const { error } = await supabase.rpc('update_agent_advance_terms' as any, {
        p_advance_id: advance.id,
        p_monthly_rate: ratePct / 100,
        p_cycle_days: days,
        p_repayment_frequency: frequency,
        p_reason: reason.trim(),
      } as any);
      if (error) throw error;
      toast.success('Advance terms updated');
      queryClient.invalidateQueries({ queryKey: ['active-advances'] });
      queryClient.invalidateQueries({ queryKey: ['cfo-advances'] });
      queryClient.invalidateQueries({ queryKey: ['advances-analytics'] });
      onSaved?.();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(e.message || 'Could not update terms');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" /> Edit advance terms
          </DialogTitle>
          <DialogDescription>
            {advance?.agent_name ? `${advance.agent_name} · ` : ''}
            Principal {formatUGX(Number(advance?.principal || 0))}. Amounts already repaid are kept.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Interest rate (% / month)</Label>
              <Input
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value.replace(/[^0-9.]/g, ''))}
                className="mt-1"
              />
              {!rateValid && <p className="text-[11px] text-destructive mt-1">0 – 100 only.</p>}
            </div>
            <div>
              <Label>Term (days)</Label>
              <Input
                inputMode="numeric"
                value={cycleDays}
                onChange={(e) => setCycleDays(e.target.value.replace(/[^0-9]/g, ''))}
                className="mt-1"
              />
              {!daysValid && <p className="text-[11px] text-destructive mt-1">1 – 365 only.</p>}
            </div>
            <div className="col-span-2">
              <Label>Repayment frequency</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as RepaymentFrequency)}>
                <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REPAYMENT_FREQUENCIES.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {preview && (
            <div className="rounded-xl border bg-muted/30 p-3 text-xs space-y-1">
              <div className="flex justify-between"><span className="text-muted-foreground">New access fee</span><span className="font-semibold">{formatUGX(preview.newFee)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">New total repayable</span><span className="font-semibold">{formatUGX(preview.newTotal)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Already repaid</span><span className="font-semibold">{formatUGX(preview.paid)}</span></div>
              <div className="flex justify-between border-t pt-1"><span className="text-muted-foreground">New outstanding</span><span className="font-bold">{formatUGX(preview.newOutstanding)}</span></div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">{frequencyLabel(frequency)} installment</span>
                <span className="font-semibold">{formatUGX(preview.installment)} × {preview.count}</span>
              </div>
            </div>
          )}

          <div>
            <Label>Reason (min {MIN_REASON} characters)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value.slice(0, 500))}
              placeholder="Why are these terms being changed?"
              className="mt-1 text-sm"
              rows={3}
            />
            <p className="text-[10px] text-muted-foreground mt-1">{reason.trim().length}/{MIN_REASON}</p>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={!canSave}>
            {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Save terms
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default EditAdvanceTermsDialog;
