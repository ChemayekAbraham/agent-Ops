import { useState } from 'react';
import { useCurrency } from '@/hooks/useCurrency';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { 
  Loader2, Zap, Droplets, Phone, Wifi, Tv, 
  CheckCircle2, Receipt, ArrowLeft 
} from 'lucide-react';

interface BillPaymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BillCategory = 'airtime' | 'electricity' | 'water' | 'internet' | 'tv';

const BILL_CATEGORIES: { value: BillCategory; label: string; icon: React.ReactNode; placeholder: string }[] = [
  { value: 'airtime', label: 'Airtime', icon: <Phone className="h-6 w-6" />, placeholder: 'Phone number' },
  { value: 'electricity', label: 'Electricity', icon: <Zap className="h-6 w-6" />, placeholder: 'Meter number' },
  { value: 'water', label: 'Water', icon: <Droplets className="h-6 w-6" />, placeholder: 'Account number' },
  { value: 'internet', label: 'Internet', icon: <Wifi className="h-6 w-6" />, placeholder: 'Account ID' },
  { value: 'tv', label: 'TV / DStv', icon: <Tv className="h-6 w-6" />, placeholder: 'Smart card number' },
];

const AIRTIME_AMOUNTS = [1000, 2000, 5000, 10000, 20000, 50000];

export function BillPaymentDialog({ open, onOpenChange }: BillPaymentDialogProps) {
  const { user } = useAuth();
  const { wallet } = useWallet();
  const [category, setCategory] = useState<BillCategory | null>(null);
  const [accountNumber, setAccountNumber] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const { formatAmount: formatCurrency } = useCurrency();

  const selectedCategory = BILL_CATEGORIES.find(c => c.value === category);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !category) return;

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error('Please enter a valid amount');
      return;
    }

    if (!accountNumber.trim()) {
      toast.error(`Please enter your ${selectedCategory?.placeholder || 'account number'}`);
      return;
    }

    setLoading(true);
    try {
      // Backend-only flow — server validates spendable balance, writes balanced
      // ledger pair, and the wallet UI refreshes via the realtime `wallets`
      // subscription in useWallet. The client must NOT touch wallet/ledger.
      const { data, error } = await supabase.functions.invoke('pay-bill', {
        body: {
          category,
          account_number: accountNumber.trim(),
          amount: amountNum,
        },
      });
      if (error) throw new Error(error.message || 'Payment failed');
      if (data?.error) throw new Error(data.error);

      setSuccess(true);
      toast.success(`${selectedCategory?.label} payment of ${formatCurrency(amountNum)} submitted!`);
    } catch (error: any) {
      toast.error(error.message || 'Payment failed');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setCategory(null);
      setAccountNumber('');
      setAmount('');
      setSuccess(false);
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        {success ? (
          <div className="py-8 flex flex-col items-center justify-center text-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center">
              <CheckCircle2 className="h-8 w-8 text-success" />
            </div>
            <p className="text-lg font-semibold">Payment Submitted!</p>
            <p className="text-sm text-muted-foreground">
              Your {selectedCategory?.label} payment of {formatCurrency(parseFloat(amount || '0'))} is being processed.
            </p>
            <Button onClick={() => handleClose(false)} className="w-full">Done</Button>
          </div>
        ) : !category ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-accent/10">
                  <Receipt className="h-5 w-5 text-accent-foreground" />
                </div>
                Pay Bills
              </DialogTitle>
              <DialogDescription>
                Pay for utilities and services from your Welile wallet
              </DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 pt-4">
              {BILL_CATEGORIES.map((cat) => (
                <button
                  key={cat.value}
                  onClick={() => setCategory(cat.value)}
                  className="flex flex-col items-center gap-2 p-4 rounded-2xl border border-border hover:border-primary hover:bg-primary/5 transition-all active:scale-95 touch-manipulation"
                >
                  <div className="p-3 rounded-xl bg-muted">
                    {cat.icon}
                  </div>
                  <span className="text-sm font-semibold">{cat.label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-center text-muted-foreground pt-2">
              Balance: {formatCurrency(wallet?.balance || 0)}
            </p>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setCategory(null)}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                {selectedCategory?.icon}
                {selectedCategory?.label}
              </DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4 pt-2">
              <div className="space-y-2">
                <Label>{selectedCategory?.placeholder}</Label>
                <Input
                  type="text"
                  placeholder={selectedCategory?.placeholder}
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label>Amount (UGX)</Label>
                <Input
                  type="number"
                  placeholder="Enter amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="text-lg font-medium"
                  min="500"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Available: {formatCurrency(wallet?.balance || 0)}
                </p>
              </div>

              {category === 'airtime' && (
                <div className="flex flex-wrap gap-2">
                  {AIRTIME_AMOUNTS.map((amt) => (
                    <Button
                      key={amt}
                      type="button"
                      variant={amount === amt.toString() ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setAmount(amt.toString())}
                    >
                      {formatCurrency(amt)}
                    </Button>
                  ))}
                </div>
              )}

              <Button type="submit" disabled={loading} className="w-full gap-2" size="lg">
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : selectedCategory?.icon}
                Pay {amount ? formatCurrency(parseFloat(amount)) : ''}
              </Button>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
