import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Banknote, CheckCircle2, Wallet, AlertCircle, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';

interface ProxyPartnerDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partner: { id: string; full_name: string; phone: string } | null;
  onSuccess?: () => void;
}

export function ProxyPartnerDepositDialog({
  open, onOpenChange, partner, onSuccess,
}: ProxyPartnerDepositDialogProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState<number>(0);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);
  const [agentBalance, setAgentBalance] = useState<number>(0);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [result, setResult] = useState<any>(null);

  useEffect(() => {
    if (open && user) {
      setAmount(0);
      setNotes('');
      setResult(null);
      fetchBalance();
    }
  }, [open, user]);

  const fetchBalance = async () => {
    if (!user) return;
    setLoadingBalance(true);
    const { data } = await supabase
      .from('wallets')
      .select('balance')
      .eq('user_id', user.id)
      .single();
    setAgentBalance(data?.balance ?? 0);
    setLoadingBalance(false);
  };

  const isValid = amount >= 500 && amount <= agentBalance;

  const handleDeposit = async () => {
    if (!user || !partner || !isValid) return;
    setLoading(true);
    try {
      const { data, error } = await supabase.rpc('agent_deposit_to_partner', {
        p_agent_id: user.id,
        p_partner_id: partner.id,
        p_amount: amount,
        p_notes: notes.trim() || null,
      });

      if (error) throw error;

      const res = data as any;
      if (!res.success) {
        toast.error('Transfer failed', { description: res.error });
        setLoading(false);
        return;
      }

      setResult(res);
      toast.success('Deposit successful!', {
        description: `${formatUGX(amount)} sent to ${partner.full_name}`,
      });
    } catch (err: any) {
      toast.error('Transfer failed', { description: err.message });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (result) onSuccess?.();
    onOpenChange(false);
  };

  if (!partner) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Banknote className="h-5 w-5 text-success" />
            Deposit to Partner
          </DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-4 py-2">
            <div className="flex flex-col items-center gap-2">
              <div className="w-14 h-14 rounded-full bg-success/15 flex items-center justify-center">
                <CheckCircle2 className="h-7 w-7 text-success" />
              </div>
              <h3 className="text-lg font-bold">Transfer Complete!</h3>
              <p className="text-xs text-muted-foreground">Ref: {result.tracking_id}</p>
            </div>

            <div className="bg-muted/30 rounded-xl p-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Amount Sent</span>
                <span className="font-mono font-bold text-success">{formatUGX(result.amount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Partner</span>
                <span className="font-semibold">{result.partner_name}</span>
              </div>
              {result.commission_earned > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Commission Earned (1%)</span>
                  <span className="font-mono font-bold text-primary">{formatUGX(result.commission_earned)}</span>
                </div>
              )}
              <div className="border-t border-border/40 pt-2 mt-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><Wallet className="h-3 w-3" /> Your Balance</span>
                  <span className="font-mono font-bold">{formatUGX(result.agent_balance_after)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground flex items-center gap-1"><Wallet className="h-3 w-3" /> Partner Balance</span>
                  <span className="font-mono font-bold text-success">{formatUGX(result.partner_balance_after)}</span>
                </div>
              </div>
            </div>

            <Button onClick={handleClose} className="w-full h-12 font-bold">Done</Button>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Agent balance */}
            <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 flex items-center gap-3">
              <Wallet className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Your Available Balance</p>
                <p className="text-lg font-bold font-mono text-primary">
                  {loadingBalance ? <Loader2 className="h-4 w-4 animate-spin" /> : formatUGX(agentBalance)}
                </p>
              </div>
            </div>

            {/* Partner info */}
            <div className="rounded-xl bg-muted/30 border border-border/40 p-3 flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-success/10 flex items-center justify-center shrink-0">
                <Banknote className="h-5 w-5 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Sending To</p>
                <p className="text-sm font-bold truncate">{partner.full_name}</p>
                <p className="text-xs text-muted-foreground">{partner.phone}</p>
              </div>
            </div>

            {agentBalance < 500 && (
              <div className="flex items-center gap-2 bg-destructive/10 border border-destructive/20 rounded-xl p-3">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                <p className="text-xs text-destructive">Insufficient balance. Top up your wallet first.</p>
              </div>
            )}

            {/* Amount */}
            <div>
              <Label className="text-xs">Amount (UGX) *</Label>
              <Input
                type="number"
                placeholder="e.g. 50000"
                value={amount || ''}
                onChange={e => setAmount(Number(e.target.value))}
                min={500}
                max={agentBalance}
                className="h-12 text-lg font-mono font-bold"
                style={{ fontSize: '18px' }}
              />
              {amount > agentBalance && (
                <div className="flex items-center gap-1.5 mt-1">
                  <AlertCircle className="h-3 w-3 text-destructive" />
                  <p className="text-[10px] text-destructive">Exceeds your available balance</p>
                </div>
              )}
            </div>

            {/* Preview */}
            {amount >= 500 && amount <= agentBalance && (
              <div className="rounded-xl bg-success/5 border border-success/20 p-3 space-y-1">
                <p className="text-xs text-muted-foreground font-medium">Transfer Preview</p>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">You send</span>
                  <span className="font-mono font-bold text-sm">{formatUGX(amount)}</span>
                </div>
                <div className="flex items-center gap-2 justify-center py-1">
                  <ArrowRight className="h-4 w-4 text-success" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{partner.full_name} receives</span>
                  <span className="font-mono font-bold text-sm text-success">{formatUGX(amount)}</span>
                </div>
                <div className="border-t border-success/20 pt-1 mt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Your commission (1%)</span>
                    <span className="font-mono font-bold text-sm text-primary">{formatUGX(Math.round(amount * 0.01))}</span>
                  </div>
                </div>
              </div>
            )}

            {/* Quick amounts */}
            <div className="flex gap-2 flex-wrap">
              {[10000, 20000, 50000, 100000]
                .filter(v => v <= agentBalance)
                .map(val => (
                  <button
                    key={val}
                    onClick={() => setAmount(val)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-mono font-bold transition-all ${
                      amount === val ? 'bg-primary text-primary-foreground' : 'bg-muted/60 text-foreground'
                    }`}
                    style={{ touchAction: 'manipulation', minHeight: '36px' }}
                  >
                    {formatUGX(val)}
                  </button>
                ))}
            </div>

            {/* Notes */}
            <div>
              <Label className="text-xs">Notes (optional)</Label>
              <Input
                placeholder="e.g. Monthly top-up"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                maxLength={200}
              />
            </div>

            {/* Submit */}
            <Button
              className="w-full h-12 text-base font-bold active:scale-[0.96] transition-transform"
              onClick={handleDeposit}
              disabled={!isValid || loading}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Banknote className="h-4 w-4 mr-2" />}
              Send {formatUGX(amount || 0)} to {partner.full_name}
            </Button>

            <p className="text-[10px] text-center text-muted-foreground">
              This transfer is instant. No approval needed.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
