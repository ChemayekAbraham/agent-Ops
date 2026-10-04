import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from '@/lib/motion-lite';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Loader2, Home, Phone, Coins, CheckCircle, Sparkles, Percent } from 'lucide-react';

interface PayLandlordDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface Landlord {
  id: string;
  name: string;
  phone: string;
  property_address: string;
  monthly_rent?: number | null;
  rent_balance_due?: number;
}

const formVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { staggerChildren: 0.08, delayChildren: 0.1 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 15, scale: 0.98 },
  visible: { 
    opacity: 1, 
    y: 0, 
    scale: 1,
    transition: { type: 'spring' as const, stiffness: 300, damping: 25 }
  },
};

export function PayLandlordDialog({ open, onOpenChange }: PayLandlordDialogProps) {
  const { wallet, refreshWallet } = useWallet();
  const { user } = useAuth();
  const [landlords, setLandlords] = useState<Landlord[]>([]);
  const [selectedLandlord, setSelectedLandlord] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [fetchingLandlords, setFetchingLandlords] = useState(true);
  const [success, setSuccess] = useState(false);
  const [rentDiscount, setRentDiscount] = useState(0);
  const [maxDiscount, setMaxDiscount] = useState(0);

  useEffect(() => {
    if (open && user) {
      fetchLandlords();
      fetchRentDiscount();
    }
  }, [open, user]);

  const fetchLandlords = async () => {
    if (!user) return;
    setFetchingLandlords(true);
    
    // Get landlords registered by this tenant
    const { data } = await supabase
      .from('landlords')
      .select('id, name, phone, property_address, monthly_rent, rent_balance_due')
      .eq('tenant_id', user.id)
      .order('name');
    
    const landlordList = data || [];
    setLandlords(landlordList);
    
    // Auto-select if only one landlord and pre-fill rent amount
    if (landlordList.length === 1) {
      setSelectedLandlord(landlordList[0].id);
      if (landlordList[0].monthly_rent) {
        const rentAmount = landlordList[0].monthly_rent.toString();
        setAmount(rentAmount);
        handleAmountChange(rentAmount);
      }
    }
    
    setFetchingLandlords(false);
  };

  const fetchRentDiscount = async () => {
    if (!user) return;

    // Get current month's verified receipts
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59).toISOString();

    const { data: receipts } = await supabase
      .from('user_receipts')
      .select('claimed_amount')
      .eq('user_id', user.id)
      .eq('verified', true)
      .gte('verified_at', startOfMonth)
      .lte('verified_at', endOfMonth);

    const totalVerified = receipts?.reduce((sum, r) => sum + Number(r.claimed_amount), 0) || 0;
    const discount = Math.round(totalVerified * 0.01); // 1% of verified receipts
    setRentDiscount(discount);
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);
  };

  const handleAmountChange = (value: string) => {
    setAmount(value);
    const amountNum = parseFloat(value) || 0;
    // Max discount is 70% of rent amount
    const max = Math.round(amountNum * 0.7);
    setMaxDiscount(max);
  };

  const getApplicableDiscount = () => {
    // Discount is minimum of earned discount and 70% of rent
    return Math.min(rentDiscount, maxDiscount);
  };

  const getFinalAmount = () => {
    const amountNum = parseFloat(amount) || 0;
    return Math.max(0, amountNum - getApplicableDiscount());
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const amountNum = parseFloat(amount);
    if (!selectedLandlord || isNaN(amountNum) || amountNum <= 0) {
      toast.error('Please select a landlord and enter valid amount');
      return;
    }

    const finalAmount = getFinalAmount();
    if (!wallet || wallet.balance < finalAmount) {
      toast.error('Insufficient wallet balance');
      return;
    }

    setLoading(true);

    // Get landlord details
    const landlord = landlords.find(l => l.id === selectedLandlord);
    if (!landlord) {
      toast.error('Landlord not found');
      setLoading(false);
      return;
    }

    // Find landlord's profile by phone to send money
    const { data: landlordProfile } = await supabase
      .from('profiles')
      .select('id')
      .eq('phone', landlord.phone)
      .maybeSingle();

    if (!landlordProfile) {
      // Landlord doesn't have a Welile account — use edge function for ledger-based deduction
      const { error } = await supabase.functions.invoke('wallet-transfer', {
        body: {
          recipient_id: null,
          amount: finalAmount,
          description: `Rent payment to ${landlord.name} (no account) - Discount: ${formatCurrency(getApplicableDiscount())}`,
          landlord_id: selectedLandlord,
        },
      });

      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Payment failed');
        toast.error(msg);
        setLoading(false);
        return;
      }
    } else {
      // Use wallet transfer
      const { error } = await supabase.functions.invoke('wallet-transfer', {
        body: {
          recipient_id: landlordProfile.id,
          amount: finalAmount,
          description: `Rent payment (Discount: ${formatCurrency(getApplicableDiscount())})`
        }
      });

      if (error) {
        const { extractFromErrorObject } = await import('@/lib/extractEdgeFunctionError');
        const msg = await extractFromErrorObject(error, 'Payment failed');
        toast.error(msg);
        setLoading(false);
        return;
      }
    }

    // Reduce the rent balance on the landlord record
    await supabase.rpc('record_rent_payment', {
      p_landlord_id: selectedLandlord,
      p_amount: finalAmount,
    });

    await refreshWallet();
    setSuccess(true);
    toast.success(`Rent paid successfully! You saved ${formatCurrency(getApplicableDiscount())}`);
    
    setTimeout(() => {
      setSelectedLandlord('');
      setAmount('');
      setSuccess(false);
      onOpenChange(false);
    }, 1500);

    setLoading(false);
  };

  const handleClose = (value: boolean) => {
    if (!value) {
      setSelectedLandlord('');
      setAmount('');
      setSuccess(false);
    }
    onOpenChange(value);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md overflow-hidden border-border/50 glass-card">
        <div className="absolute inset-0 bg-gradient-to-br from-success/5 via-transparent to-primary/5 pointer-events-none" />
        
        <AnimatePresence mode="wait">
          {success ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              className="py-12 flex flex-col items-center justify-center relative"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring' as const, stiffness: 300, damping: 20, delay: 0.1 }}
                className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center mb-4"
              >
                <CheckCircle className="h-10 w-10 text-success" />
              </motion.div>
              <motion.p
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-lg font-semibold"
              >
                Rent Paid!
              </motion.p>
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-muted-foreground text-sm"
              >
                You saved {formatCurrency(getApplicableDiscount())}
              </motion.p>
            </motion.div>
          ) : (
            <motion.div
              key="form"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="relative"
            >
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <motion.div
                    className="p-2 rounded-lg bg-success/10"
                    whileHover={{ scale: 1.1, rotate: 5 }}
                    transition={{ type: 'spring' as const, stiffness: 400, damping: 17 }}
                  >
                    <Home className="h-5 w-5 text-success" />
                  </motion.div>
                  Pay Landlord
                </DialogTitle>
                <DialogDescription>
                  Pay rent directly from your wallet and earn discounts from your receipts
                </DialogDescription>
              </DialogHeader>

              {/* Rent Discount Banner */}
              {rentDiscount > 0 && (
                <motion.div 
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-4 p-3 rounded-xl bg-gradient-to-r from-success/10 to-success/5 border border-success/20"
                >
                  <div className="flex items-center gap-2 text-success">
                    <Percent className="h-4 w-4" />
                    <span className="text-sm font-medium">
                      You have {formatCurrency(rentDiscount)} in rent discounts this month!
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Based on 1% of your verified shopping receipts (max 70% of rent)
                  </p>
                </motion.div>
              )}

              <motion.form 
                onSubmit={handleSubmit} 
                className="space-y-4 mt-4"
                variants={formVariants}
                initial="hidden"
                animate="visible"
              >
                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="landlord" className="flex items-center gap-2">
                    <Home className="h-3.5 w-3.5 text-muted-foreground" />
                    Select Landlord
                  </Label>
                  <Select 
                    value={selectedLandlord} 
                    onValueChange={(value) => {
                      setSelectedLandlord(value);
                      // Auto-fill rent amount when landlord is selected
                      const landlord = landlords.find(l => l.id === value);
                      if (landlord?.monthly_rent) {
                        const rentAmount = landlord.monthly_rent.toString();
                        setAmount(rentAmount);
                        handleAmountChange(rentAmount);
                      }
                    }}
                  >
                    <SelectTrigger className="bg-background/50 border-border/50">
                      <SelectValue placeholder={fetchingLandlords ? "Loading..." : "Select landlord"} />
                    </SelectTrigger>
                    <SelectContent>
                      {landlords.map((landlord) => (
                        <SelectItem key={landlord.id} value={landlord.id}>
                          <div className="flex flex-col">
                            <span>{landlord.name}</span>
                            <span className="text-xs text-muted-foreground">
                              {landlord.property_address}
                              {landlord.monthly_rent && ` • UGX ${landlord.monthly_rent.toLocaleString()}/mo`}
                            </span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </motion.div>

                <motion.div variants={itemVariants} className="space-y-2">
                  <Label htmlFor="amount" className="flex items-center gap-2">
                    <Coins className="h-3.5 w-3.5 text-muted-foreground" />
                    Rent Amount (UGX)
                  </Label>
                  <Input
                    id="amount"
                    type="number"
                    placeholder="Enter rent amount"
                    value={amount}
                    onChange={(e) => handleAmountChange(e.target.value)}
                    className="bg-background/50 border-border/50 focus:border-primary/50 transition-all text-lg font-medium"
                    min="1"
                    required
                  />
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Sparkles className="h-3 w-3" />
                    Available: {formatCurrency(wallet?.balance || 0)}
                  </p>
                </motion.div>

                {/* Rent Balance Due */}
                {selectedLandlord && (() => {
                  const landlord = landlords.find(l => l.id === selectedLandlord);
                  const balance = landlord?.rent_balance_due ?? 0;
                  return (
                    <motion.div variants={itemVariants} className={`p-3 rounded-xl border text-xs flex items-center justify-between ${balance > 0 ? 'bg-destructive/10 border-destructive/20' : 'bg-success/10 border-success/20'}`}>
                      <span className="text-muted-foreground">Current Rent Balance Due</span>
                      <span className={`font-bold text-sm ${balance > 0 ? 'text-destructive' : 'text-success'}`}>
                        {balance > 0 ? formatCurrency(balance) : '✓ Fully Paid'}
                      </span>
                    </motion.div>
                  );
                })()}

                {/* Payment Summary */}
                {amount && parseFloat(amount) > 0 && (
                  <motion.div 
                    variants={itemVariants}
                    className="p-4 rounded-xl bg-secondary/30 border border-border/50 space-y-2"
                  >
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Rent Amount</span>
                      <span>{formatCurrency(parseFloat(amount))}</span>
                    </div>
                    {getApplicableDiscount() > 0 && (
                      <div className="flex justify-between text-sm text-success">
                        <span>Receipt Discount (1%)</span>
                        <span>-{formatCurrency(getApplicableDiscount())}</span>
                      </div>
                    )}
                    <div className="border-t border-border pt-2 flex justify-between font-semibold">
                      <span>You Pay</span>
                      <span className="text-lg">{formatCurrency(getFinalAmount())}</span>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground pt-1">
                      <span>Balance after payment</span>
                      <span className={getFinalAmount() >= (landlords.find(l => l.id === selectedLandlord)?.rent_balance_due ?? 0) ? 'text-success font-medium' : 'text-warning font-medium'}>
                        {formatCurrency(Math.max(0, (landlords.find(l => l.id === selectedLandlord)?.rent_balance_due ?? 0) - getFinalAmount()))}
                      </span>
                    </div>
                  </motion.div>
                )}

                <motion.div variants={itemVariants}>
                  <DialogFooter className="gap-2 sm:gap-0">
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button type="button" variant="outline" onClick={() => handleClose(false)}>
                        Cancel
                      </Button>
                    </motion.div>
                    <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}>
                      <Button type="submit" disabled={loading} className="gap-2 bg-success hover:bg-success/90">
                        {loading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Home className="h-4 w-4" />
                        )}
                        Pay Rent
                      </Button>
                    </motion.div>
                  </DialogFooter>
                </motion.div>
              </motion.form>
            </motion.div>
          )}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}