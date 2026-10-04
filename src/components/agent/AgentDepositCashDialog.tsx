import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useProfile } from '@/hooks/useProfile';
import { Loader2, CheckCircle2, ArrowDownCircle, AlertCircle, Smartphone, Building2, Banknote, CreditCard, Phone, Wallet } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { safeDepositPurpose } from '@/lib/depositPurposeGuard';

interface AgentDepositCashDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type DepositType = 'float' | 'operations_float' | 'rent_repayment';

const USSD_DIAL: Record<string, string> = {
  mtn: 'tel:*165*4%23',     // *165*4#
  airtel: 'tel:*185*9%23',  // *185*9#
};

export function AgentDepositCashDialog({ open, onOpenChange, onSuccess }: AgentDepositCashDialogProps) {
  const { profile } = useProfile();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [depositType, setDepositType] = useState<DepositType>('float');
  const [method, setMethod] = useState<'mtn' | 'airtel' | 'bank'>('mtn');
  const [transactionId, setTransactionId] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const handleClose = () => {
    setAmount(''); setDepositType('float'); setMethod('mtn'); setTransactionId(''); setSuccess(false);
    onOpenChange(false);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile?.id) return;

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    if (!transactionId.trim() || transactionId.trim().length < 8) {
      toast({ title: 'Enter a valid transaction/reference ID (min 8 chars)', variant: 'destructive' });
      return;
    }

    setLoading(true);

    // Create a deposit request for manager verification
    const { error: insertError } = await supabase
      .from('deposit_requests')
      .insert({
        user_id: profile.id, // Agent is depositing their own collected cash
        agent_id: profile.id,
        amount: amountNum,
        provider: method,
        transaction_id: transactionId.trim().toUpperCase(),
        notes: `Agent cash deposit for: ${depositType}`,
        status: 'pending',
        deposit_purpose: safeDepositPurpose('other'),
      });

    setLoading(false);

    if (insertError) {
      if (insertError.code === '23505') {
        toast({ title: 'This transaction ID has already been submitted', variant: 'destructive' });
      } else {
        toast({ title: 'Failed to submit deposit', description: insertError.message, variant: 'destructive' });
      }
      return;
    }

    setSuccess(true);
    // STRICT LEDGER REFRESH: never trust local state — invalidate every wallet-derived query
    // so the UI re-reads from `wallets` (which is now the ledger-backed view). No optimistic
    // setBalance / manual balance mutation is performed here.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['wallets'] }),
      queryClient.invalidateQueries({ queryKey: ['wallet'] }),
      queryClient.invalidateQueries({ queryKey: ['agent-balances'] }),
      queryClient.invalidateQueries({ queryKey: ['user-available-balance'] }),
      queryClient.invalidateQueries({ queryKey: ['v_user_wallet_strict'] }),
      queryClient.invalidateQueries({ queryKey: ['agent_float_limits'] }),
    ]);
    toast({ 
      title: 'Deposit submitted for verification!',
      description: 'Once a manager approves this, your float will be updated.'
    });
    onSuccess?.();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowDownCircle className="h-5 w-5 text-success" />
            Deposit Collected Cash
          </DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="text-center space-y-4 py-4">
            <div className="w-16 h-16 mx-auto bg-success/20 rounded-full flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <h3 className="text-lg font-semibold">Deposit Received!</h3>
            <p className="text-sm text-muted-foreground">{formatUGX(parseFloat(amount))}</p>
            <p className="text-sm font-medium text-success">
              {depositType === 'float' ? 'Float Capacity Restored' : depositType === 'operations_float' ? 'Operations Float Credited' : 'Rent Repayment Recorded'}
            </p>
            <Button onClick={handleClose} className="w-full h-12">Done</Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Deposit Type Selection */}
            <div className="space-y-3">
              <Label className="font-semibold">Deposit Type</Label>
              <RadioGroup value={depositType} onValueChange={(v) => setDepositType(v as DepositType)} className="space-y-2">
                <Label
                  htmlFor="type-float"
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                    depositType === 'float' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                  }`}
                >
                  <RadioGroupItem value="float" id="type-float" className="sr-only" />
                  <Banknote className="h-5 w-5 text-primary" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">Float (Cash-Out)</p>
                    <p className="text-xs text-muted-foreground">Replenish cash-out float capacity</p>
                  </div>
                </Label>
                <Label
                  htmlFor="type-ops-float"
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                    depositType === 'operations_float' ? 'border-success bg-success/5' : 'border-border hover:border-success/30'
                  }`}
                >
                  <RadioGroupItem value="operations_float" id="type-ops-float" className="sr-only" />
                  <Wallet className="h-5 w-5 text-success" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">Agent Operations Float</p>
                    <p className="text-xs text-muted-foreground">For paying tenant rent from your wallet</p>
                  </div>
                </Label>
                <Label
                  htmlFor="type-rent"
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                    depositType === 'rent_repayment' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                  }`}
                >
                  <RadioGroupItem value="rent_repayment" id="type-rent" className="sr-only" />
                  <CreditCard className="h-5 w-5 text-emerald-600" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">Rent Repayment</p>
                    <p className="text-xs text-muted-foreground">Tenant cash repayment — reduces tenant debt directly</p>
                  </div>
                </Label>
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label>Amount (UGX)</Label>
              <Input
                type="number"
                placeholder="e.g. 200000"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="h-12"
                min="1"
              />
            </div>

            <div className="space-y-3">
              <Label>Deposit Method</Label>
              <RadioGroup value={method} onValueChange={(v) => setMethod(v as any)} className="space-y-2">
                {[
                  { value: 'mtn', label: 'MTN MoMo Merchant', icon: Smartphone, color: 'text-yellow-600', code: '090777' },
                  { value: 'airtel', label: 'Airtel Money Merchant', icon: Smartphone, color: 'text-red-600', code: '4380664' },
                  { value: 'bank', label: 'Bank Deposit Reference', icon: Building2, color: 'text-blue-600', code: '' },
                ].map(opt => (
                  <Label
                    key={opt.value}
                    htmlFor={`deposit-${opt.value}`}
                    className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-all ${
                      method === opt.value ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/30'
                    }`}
                  >
                    <RadioGroupItem value={opt.value} id={`deposit-${opt.value}`} className="sr-only" />
                    <opt.icon className={`h-5 w-5 ${opt.color}`} />
                    <div className="flex-1">
                      <p className="font-medium text-sm">{opt.label}</p>
                      {opt.code && <p className="text-xs text-muted-foreground">{opt.code}</p>}
                    </div>
                  </Label>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label>Transaction / Reference ID</Label>
              <Input
                type="text"
                placeholder="e.g. TID12345678"
                value={transactionId}
                onChange={(e) => setTransactionId(e.target.value.toUpperCase())}
                className="h-12 font-mono uppercase"
                maxLength={30}
              />
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                From your mobile money SMS or bank deposit slip
              </p>
            </div>

            {/* USSD Dial Now Button */}
            {(method === 'mtn' || method === 'airtel') && (
              <div className="space-y-2">
                <a href={USSD_DIAL[method]} className="block">
                  <Button
                    type="button"
                    className={`w-full h-12 text-base font-bold ${
                      method === 'mtn'
                        ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                        : 'bg-red-600 hover:bg-red-700 text-white'
                    }`}
                  >
                    <Phone className="h-5 w-5 mr-2" />
                    Dial Now — {method === 'mtn' ? 'MTN MoMo' : 'Airtel Money'}
                  </Button>
                </a>
                <p className="text-xs text-center text-muted-foreground">
                  Tap to open your phone dialer and complete payment instantly.
                </p>
              </div>
            )}

            {/* Context info based on deposit type */}
            {depositType === 'rent_repayment' && (
              <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-muted-foreground">
                💡 This deposit bypasses your wallet and goes directly to reducing the tenant's debt and recognizing platform revenue.
              </div>
            )}

            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleClose} className="flex-1 h-12">Cancel</Button>
              <Button type="submit" disabled={loading} className="flex-1 h-12">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Submit Deposit'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}