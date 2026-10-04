import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Banknote, Phone, AlertCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';

interface RequestCommissionPayoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableBalance: number;
  onSuccess?: () => void;
}

export function RequestCommissionPayoutDialog({
  open,
  onOpenChange,
  availableBalance,
  onSuccess
}: RequestCommissionPayoutDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [provider, setProvider] = useState<'MTN' | 'Airtel'>('MTN');
  const [hasSavedNumber, setHasSavedNumber] = useState(false);

  useEffect(() => {
    if (open && user) {
      fetchSavedNumber();
    }
  }, [open, user]);

  const fetchSavedNumber = async () => {
    if (!user) return;

    const { data } = await supabase
      .from('profiles')
      .select('mobile_money_number, mobile_money_provider')
      .eq('id', user.id)
      .single();

    if (data?.mobile_money_number) {
      setMobileNumber(data.mobile_money_number);
      setHasSavedNumber(true);
    }
    if (data?.mobile_money_provider) {
      setProvider(data.mobile_money_provider as 'MTN' | 'Airtel');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // FROZEN: Commission payouts temporarily suspended
    toast({ 
      title: 'Commission payouts are temporarily suspended', 
      description: 'This feature is currently inactive. Please contact management for assistance.',
      variant: 'destructive' 
    });
    return;
    
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast({ title: 'Please enter a valid amount', variant: 'destructive' });
      return;
    }

    if (amountNum > availableBalance) {
      toast({ title: 'Amount exceeds available balance', variant: 'destructive' });
      return;
    }

    const trimmedNumber = mobileNumber.trim();
    if (!trimmedNumber) {
      toast({ title: 'Please enter a mobile money number', variant: 'destructive' });
      return;
    }

    hapticTap();
    setLoading(true);

    try {
      const { error } = await supabase
        .from('agent_commission_payouts')
        .insert({
          agent_id: user?.id,
          amount: amountNum,
          mobile_money_number: trimmedNumber,
          mobile_money_provider: provider,
          status: 'pending'
        });

      if (error) throw error;

      // Also save the number to profile if not already saved
      if (!hasSavedNumber) {
        await supabase
          .from('profiles')
          .update({
            mobile_money_number: trimmedNumber,
            mobile_money_provider: provider
          })
          .eq('id', user?.id);
      }

      toast({ 
        title: 'Payout request submitted!', 
        description: 'Please wait for manager approval before funds are released.',
      });
      onSuccess?.();
      onOpenChange(false);
      setAmount('');
    } catch (error: any) {
      toast({ title: 'Failed to submit request', description: error.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  };

  const quickAmounts = [10000, 50000, 100000];
  const hasBalance = availableBalance > 0;
  const parsedAmount = parseFloat(amount) || 0;
  const isValidAmount = parsedAmount > 0 && parsedAmount <= availableBalance;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Banknote className="h-5 w-5 text-success" />
            Request Commission Payout
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Available balance */}
          <div className={`p-3 rounded-xl border ${hasBalance ? 'bg-success/10 border-success/20' : 'bg-muted/50 border-muted'}`}>
            <p className="text-xs text-muted-foreground">Available Commission</p>
            <p className={`text-xl font-bold ${hasBalance ? 'text-success' : 'text-muted-foreground'}`}>
              {formatUGX(availableBalance)}
            </p>
          </div>

          {!hasBalance ? (
            <div className="flex items-center gap-2 p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-600 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>You have no commission balance to withdraw. Earn commissions by registering tenants and processing their rent requests.</span>
            </div>
          ) : (
            <>
              {/* Amount */}
              <div className="space-y-2">
                <Label htmlFor="amount">Amount to Withdraw (UGX)</Label>
                <Input
                  id="amount"
                  type="number"
                  placeholder="e.g. 50000"
                  value={amount}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === '') {
                      setAmount('');
                      return;
                    }
                    const numValue = parseFloat(value);
                    if (!isNaN(numValue) && numValue > availableBalance) {
                      setAmount(String(availableBalance));
                      toast({
                        title: 'Amount capped to balance',
                        description: `Maximum withdrawal is ${formatUGX(availableBalance)}`,
                        variant: 'default',
                      });
                    } else {
                      setAmount(value);
                    }
                  }}
                  className="h-12 text-base"
                  disabled={loading}
                  min="1"
                  max={availableBalance}
                />
                {parsedAmount > 0 && parsedAmount === availableBalance && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Withdrawing full balance
                  </p>
                )}
                <div className="flex gap-2">
                  {quickAmounts.map((amt) => (
                    <Button
                      key={amt}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setAmount(String(Math.min(amt, availableBalance)))}
                      disabled={amt > availableBalance}
                      className="flex-1 text-xs"
                    >
                      {amt >= 1000 ? `${amt / 1000}K` : amt}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAmount(String(availableBalance))}
                    className="flex-1 text-xs"
                  >
                    All
                  </Button>
                </div>
              </div>

              {/* Provider */}
              <div className="space-y-2">
                <Label>Mobile Money Provider</Label>
                <RadioGroup
                  value={provider}
                  onValueChange={(v) => setProvider(v as 'MTN' | 'Airtel')}
                  className="flex gap-4"
                >
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="MTN" id="payout-mtn" />
                    <Label htmlFor="payout-mtn" className="font-medium text-yellow-600">MTN</Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="Airtel" id="payout-airtel" />
                    <Label htmlFor="payout-airtel" className="font-medium text-red-600">Airtel</Label>
                  </div>
                </RadioGroup>
              </div>

              {/* Phone number */}
              <div className="space-y-2">
                <Label htmlFor="payout-phone">Phone Number</Label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="payout-phone"
                    type="tel"
                    placeholder="e.g. 0770123456"
                    value={mobileNumber}
                    onChange={(e) => setMobileNumber(e.target.value)}
                    className="h-12 text-base pl-10"
                    disabled={loading}
                  />
                </div>
                {hasSavedNumber && (
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Using your saved payout number
                  </p>
                )}
              </div>
            </>
          )}

          <div className="flex gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
              className="flex-1 h-12"
            >
              {hasBalance ? 'Cancel' : 'Close'}
            </Button>
            {hasBalance && (
              <Button
                type="submit"
                disabled={loading || !isValidAmount || !mobileNumber.trim()}
                className="flex-1 h-12"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Request Payout'}
              </Button>
            )}
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
