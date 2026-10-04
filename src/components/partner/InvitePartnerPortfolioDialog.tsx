import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { useToast } from '@/hooks/use-toast';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Mail, Send } from 'lucide-react';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  partner: { id: string; full_name?: string | null; email?: string | null } | null;
  onSent?: () => void;
}

/**
 * Partner Ops → send an existing partner a secure link to complete a new
 * portfolio. No wallet is debited; the portfolio stays inert until the
 * partner signs and Ops approves.
 */
export function InvitePartnerPortfolioDialog({ open, onOpenChange, partner, onSent }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [duration, setDuration] = useState('12');
  const [roi, setRoi] = useState('15');
  const [mode, setMode] = useState<'monthly_payout' | 'monthly_compounding'>('monthly_payout');
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = () => { setAmount(''); setDuration('12'); setRoi('15'); setMode('monthly_payout'); setNickname(''); };

  const submit = async () => {
    if (!partner?.id) return;
    const amt = Number(amount.replace(/[,\s]/g, ''));
    if (!Number.isFinite(amt) || amt < 20000) {
      toast({ title: 'Amount too low', description: 'Minimum portfolio amount is UGX 20,000.', variant: 'destructive' });
      return;
    }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('create-portfolio-invite', {
        body: {
          partner_id: partner.id,
          amount: amt,
          duration_months: Number(duration),
          roi_percentage: Number(roi),
          roi_mode: mode,
          nickname: nickname.trim() || null,
        },
      });
      if (error) {
        const msg = await extractFromErrorObject(error, 'Could not send invite.');
        toast({ title: 'Invite failed', description: msg, variant: 'destructive' });
        return;
      }
      if (data?.error) {
        toast({ title: 'Invite failed', description: data.error, variant: 'destructive' });
        return;
      }
      toast({
        title: 'Invite sent',
        description: `${partner.full_name || 'The partner'} will receive a secure link at ${data?.partner_email || 'their email'}.`,
      });
      queryClient.invalidateQueries({ queryKey: ['invited-portfolios'] });
      queryClient.invalidateQueries({ queryKey: ['exec-partner-portfolios'] });
      reset();
      onOpenChange(false);
      onSent?.();
    } catch (e: any) {
      const msg = await extractFromErrorObject(e, 'Could not send invite.');
      toast({ title: 'Invite failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const amt = Number((amount || '').replace(/[,\s]/g, ''));
  const previewMonthly = Number.isFinite(amt) && amt > 0 && Number(roi) > 0
    ? Math.round(amt * (Number(roi) / 100))
    : 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent className="w-[95vw] max-w-md sm:max-w-lg p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 sm:px-6 py-4 border-b">
          <DialogTitle className="text-base sm:text-lg flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> Invite partner to add a portfolio
          </DialogTitle>
          <DialogDescription className="text-xs sm:text-sm">
            Enter the portfolio details. {partner?.full_name || 'The partner'} will receive a secure link at
            {' '}<span className="font-medium text-foreground">{partner?.email || 'their email on file'}</span> to
            review, complete missing details and sign the addendum.
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 sm:px-6 py-4 space-y-4 max-h-[65vh] overflow-y-auto">
          <div className="space-y-1.5">
            <Label htmlFor="amt" className="text-xs">Portfolio amount (UGX)</Label>
            <Input
              id="amt"
              inputMode="numeric"
              placeholder="e.g. 500,000"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="dur" className="text-xs">Duration (months)</Label>
              <Input id="dur" type="number" min={1} max={60} value={duration} onChange={(e) => setDuration(e.target.value)} disabled={busy} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="roi" className="text-xs">Monthly ROI (%)</Label>
              <Input id="roi" type="number" min={1} max={100} step="0.5" value={roi} onChange={(e) => setRoi(e.target.value)} disabled={busy} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">ROI mode</Label>
            <Select value={mode} onValueChange={(v: 'monthly_payout' | 'monthly_compounding') => setMode(v)} disabled={busy}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly_payout">Monthly payout</SelectItem>
                <SelectItem value="monthly_compounding">Monthly compounding</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nick" className="text-xs">Nickname (optional)</Label>
            <Input id="nick" placeholder="e.g. 2026 growth portfolio" value={nickname} onChange={(e) => setNickname(e.target.value)} disabled={busy} maxLength={120} />
          </div>

          {previewMonthly > 0 && (
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs">
              <p className="font-semibold text-foreground">Preview</p>
              <p className="text-muted-foreground mt-1">Monthly return: <span className="font-medium text-foreground">{formatUGX(previewMonthly)}</span></p>
              <p className="text-muted-foreground">Projected over {duration} months: <span className="font-medium text-foreground">{formatUGX(previewMonthly * Number(duration))}</span></p>
            </div>
          )}

          <p className="text-[11px] text-muted-foreground leading-relaxed">
            No wallet is charged now. The portfolio stays inactive until the partner completes the addendum and Partner Operations approves it.
          </p>
        </div>

        <DialogFooter className="px-4 sm:px-6 py-3 border-t bg-muted/30 flex-row justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy || !partner?.email} className="gap-1.5">
            {busy ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : <><Send className="h-4 w-4" /> Send invite</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default InvitePartnerPortfolioDialog;