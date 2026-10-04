import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { toast as sonnerToast } from 'sonner';
import { useProfile } from '@/hooks/useProfile';
import { Loader2, ArrowDownCircle, Smartphone, AlertCircle, Calendar, Clock, Info, Banknote, Send } from 'lucide-react';
import { QuickRegisterTenantDialog } from './QuickRegisterTenantDialog';
import { GlossaryTip } from '@/components/shared/GlossaryTip';
import { safeDepositPurpose } from '@/lib/depositPurposeGuard';

interface AgentDepositDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
  prefillPhone?: string;
}

type DepositMode = 'cash_collected' | 'customer_paid';

export function AgentDepositDialog({ open, onOpenChange, onSuccess, prefillPhone }: AgentDepositDialogProps) {
  const { profile } = useProfile();
  const [mode, setMode] = useState<DepositMode | null>(null);
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState('');
  const [provider, setProvider] = useState<'mtn' | 'airtel'>('mtn');
  const [transactionId, setTransactionId] = useState('');
  const [transactionDate, setTransactionDate] = useState('');
  const [transactionTime, setTransactionTime] = useState('');
  const [narration, setNarration] = useState('');
  const [loading, setLoading] = useState(false);
  const [showQuickRegister, setShowQuickRegister] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    mode: DepositMode;
    details?: {
      total_deposited: number;
      auto_repayment: number;
      agent_commission: number;
      to_landlord: number;
      to_wallet: number;
      user_name: string;
    };
  } | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open && prefillPhone) {
      setPhone(prefillPhone);
    }
  }, [open, prefillPhone]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('en-UG', { 
      style: 'currency', 
      currency: 'UGX',
      minimumFractionDigits: 0 
    }).format(value);
  };

  const validateForm = (): boolean => {
    if (!phone.trim() || !amount.trim()) {
      toast({ title: 'Please fill all fields', variant: 'destructive' });
      return false;
    }

    if (!transactionId.trim()) {
      toast({ 
        title: 'Transaction ID Required', 
        description: `Please enter the ${provider.toUpperCase()} transaction ID from the customer's payment`,
        variant: 'destructive' 
      });
      return false;
    }

    const trimmedTxnId = transactionId.trim().toUpperCase();
    if (trimmedTxnId.length < 8) {
      toast({ 
        title: 'Invalid Transaction ID', 
        description: 'Transaction ID must be at least 8 characters',
        variant: 'destructive' 
      });
      return false;
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      toast({ title: 'Please enter a valid amount', variant: 'destructive' });
      return false;
    }

    if (!narration.trim()) {
      toast({ title: 'Reason / Narration is required', variant: 'destructive' });
      return false;
    }

    return true;
  };

  const handleCashCollectedSubmit = async () => {
    const amountNum = parseFloat(amount);
    const trimmedTxnId = transactionId.trim().toUpperCase();

    const { data, error } = await supabase.functions.invoke('agent-deposit', {
      body: { 
        user_phone: phone.trim(), 
        amount: amountNum,
        provider,
        transaction_id: trimmedTxnId
      },
    });

    if (error) {
      const errMsg = error?.context ?
        await error.context.json().then((r: any) => r.error).catch(() => error.message)
        : error.message;
      throw new Error(errMsg || 'Deposit failed');
    }

    setResult({ success: true, mode: 'cash_collected', details: data.details });
    toast({ title: 'Deposit successful!' });
  };

  const handleCustomerPaidSubmit = async () => {
    const amountNum = parseFloat(amount);
    const trimmedTxnId = transactionId.trim().toUpperCase();

    // Look up the user by phone number
    const { data: targetUser, error: lookupError } = await supabase
      .from('profiles')
      .select('id, full_name')
      .or(`phone.eq.${phone.trim()},phone.eq.+256${phone.trim().replace(/^0/, '')}`)
      .maybeSingle();

    if (lookupError) throw new Error('Failed to look up customer');
    if (!targetUser) {
      throw new Error('No customer found with that phone number. They must be registered first.');
    }

    // Build transaction date string
    let txnDateStr: string | null = null;
    if (transactionDate) {
      txnDateStr = transactionTime 
        ? `${transactionDate}T${transactionTime}` 
        : transactionDate;
    }

    // Create a deposit request for manager verification (no wallet deduction)
    const { error: insertError } = await supabase
      .from('deposit_requests')
      .insert({
        user_id: targetUser.id,
        agent_id: profile?.id || null,
        amount: amountNum,
        provider,
        transaction_id: trimmedTxnId,
        transaction_date: txnDateStr,
        notes: narration.trim(),
        status: 'pending',
        // Explicit guard: never let Postgres receive an empty string for
        // the `deposit_purpose` enum. AgentDepositDialog has no purpose
        // selector, so all rows here default to 'other' via the shared
        // sanitiser (kept central so any future enum change is one edit).
        deposit_purpose: safeDepositPurpose(null),
      });

    if (insertError) {
      if (insertError.code === '23505') {
        throw new Error('This transaction ID has already been submitted');
      }
      throw new Error('Failed to submit deposit request');
    }

    setResult({ 
      success: true, 
      mode: 'customer_paid',
      details: {
        total_deposited: amountNum,
        auto_repayment: 0,
        agent_commission: 0,
        to_landlord: 0,
        to_wallet: amountNum,
        user_name: targetUser.full_name || phone.trim(),
      }
    });
    toast({ title: 'Deposit request submitted for verification!' });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mode || !validateForm()) return;

    setLoading(true);
    setResult(null);

    try {
      if (mode === 'cash_collected') {
        await handleCashCollectedSubmit();
      } else {
        await handleCustomerPaidSubmit();
      }
      onSuccess?.();
    } catch (error: any) {
      const msg = (error.message || '').toLowerCase();
      const isNotFound =
        msg.includes('user not found') ||
        msg.includes('no customer found') ||
        msg.includes('not registered') ||
        msg.includes('must be registered');

      if (isNotFound) {
        sonnerToast.error('Tenant not found', {
          description: `No tenant on the platform uses ${phone.trim()}. Add them now to continue.`,
          duration: 10000,
          action: {
            label: 'Add tenant',
            onClick: () => setShowQuickRegister(true),
          },
        });
      } else {
        toast({
          title: 'Deposit failed',
          description: error.message || 'Please try again',
          variant: 'destructive',
        });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setMode(null);
    setPhone('');
    setAmount('');
    setProvider('mtn');
    setTransactionId('');
    setTransactionDate('');
    setTransactionTime('');
    setNarration('');
    setResult(null);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowDownCircle className="h-5 w-5 text-success" />
              Process Customer Deposit
            </DialogTitle>
          </DialogHeader>

          {/* Success View */}
          {result?.success ? (
            <DepositSuccessView 
              result={result} 
              formatCurrency={formatCurrency} 
              onClose={handleClose} 
            />
          ) : !mode ? (
            /* Mode Selection */
            <ModeSelector onSelect={setMode} />
          ) : (
            /* Deposit Form */
            <DepositForm
              mode={mode}
              phone={phone}
              amount={amount}
              provider={provider}
              transactionId={transactionId}
              transactionDate={transactionDate}
              transactionTime={transactionTime}
              narration={narration}
              loading={loading}
              onPhoneChange={setPhone}
              onAmountChange={setAmount}
              onProviderChange={setProvider}
              onTransactionIdChange={setTransactionId}
              onTransactionDateChange={setTransactionDate}
              onTransactionTimeChange={setTransactionTime}
              onNarrationChange={setNarration}
              onSubmit={handleSubmit}
              onBack={() => setMode(null)}
              onClose={handleClose}
            />
          )}
        </DialogContent>
      </Dialog>

      <QuickRegisterTenantDialog
        open={showQuickRegister}
        onOpenChange={setShowQuickRegister}
        prefillPhone={phone}
        onRegistered={(p) => {
          setPhone(p);
          setShowQuickRegister(false);
          sonnerToast.success('Tenant added — you can now process the payment');
        }}
      />
    </>
  );
}

/* ── Mode Selector ── */
function ModeSelector({ onSelect }: { onSelect: (mode: DepositMode) => void }) {
  return (
    <div className="space-y-3 py-2">
      <p className="text-sm text-muted-foreground text-center">How did the customer pay?</p>
      
      <button
        onClick={() => onSelect('cash_collected')}
        className="w-full flex items-start gap-3 p-4 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left"
      >
        <div className="w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0 mt-0.5">
          <Banknote className="h-5 w-5 text-amber-600" />
        </div>
        <div>
          <p className="font-semibold text-sm">I Collected Cash</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Customer gave you cash. Deposit is deducted from your wallet balance and credited to their account instantly.
          </p>
        </div>
      </button>

      <button
        onClick={() => onSelect('customer_paid')}
        className="w-full flex items-start gap-3 p-4 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left"
      >
        <div className="w-10 h-10 rounded-full bg-blue-500/15 flex items-center justify-center shrink-0 mt-0.5">
          <Send className="h-5 w-5 text-blue-600" />
        </div>
        <div>
          <p className="font-semibold text-sm">Customer Paid Directly</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Customer already sent money to the merchant number. You're just submitting the transaction ID for manager verification.
          </p>
        </div>
      </button>
    </div>
  );
}

/* ── Deposit Form ── */
function DepositForm({
  mode, phone, amount, provider, transactionId, transactionDate, transactionTime, narration, loading,
  onPhoneChange, onAmountChange, onProviderChange, onTransactionIdChange, onTransactionDateChange, onTransactionTimeChange, onNarrationChange,
  onSubmit, onBack, onClose,
}: {
  mode: DepositMode;
  phone: string; amount: string; provider: 'mtn' | 'airtel';
  transactionId: string; transactionDate: string; transactionTime: string; narration: string; loading: boolean;
  onPhoneChange: (v: string) => void; onAmountChange: (v: string) => void;
  onProviderChange: (v: 'mtn' | 'airtel') => void; onTransactionIdChange: (v: string) => void;
  onTransactionDateChange: (v: string) => void; onTransactionTimeChange: (v: string) => void;
  onNarrationChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void; onBack: () => void; onClose: () => void;
}) {
  const isCustomerPaid = mode === 'customer_paid';

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Mode Badge */}
      <div className={`rounded-lg px-3 py-2 text-xs font-medium flex items-center gap-2 ${
        isCustomerPaid 
          ? 'bg-blue-500/10 text-blue-700 border border-blue-500/20' 
          : 'bg-amber-500/10 text-amber-700 border border-amber-500/20'
      }`}>
        {isCustomerPaid ? <Send className="h-3.5 w-3.5" /> : <Banknote className="h-3.5 w-3.5" />}
        {isCustomerPaid ? 'Customer Paid Directly — TID verification only' : 'Cash Collected — deducted from your wallet'}
        <button type="button" onClick={onBack} className="ml-auto text-xs underline opacity-70 hover:opacity-100">Change</button>
      </div>

      <GlossaryTip
        terms={isCustomerPaid
          ? ['Cash Collected', 'Tracking ID', 'Auto-Deduction']
          : ['Cash Collected', 'Float', 'Deposit / Refill']}
        intro={isCustomerPaid
          ? "The customer paid via Mobile Money — you're just verifying the Transaction ID."
          : 'You collected cash. Recording it deducts from your float and credits the customer.'}
      />

      <div className="space-y-2">
        <Label htmlFor="phone">Customer Phone Number</Label>
        <Input id="phone" type="tel" placeholder="e.g. 0700123456" value={phone} onChange={(e) => onPhoneChange(e.target.value)} disabled={loading} className="h-12" />
      </div>

      <div className="space-y-2">
        <Label htmlFor="amount">Amount (UGX)</Label>
        <Input id="amount" type="number" placeholder="e.g. 50000" value={amount} onChange={(e) => onAmountChange(e.target.value)} disabled={loading} min="1" className="h-12" />
      </div>

      {/* Payment Provider */}
      <div className="space-y-3">
        <Label className="flex items-center gap-2"><Smartphone className="h-4 w-4" /> Payment Provider</Label>
        <RadioGroup value={provider} onValueChange={(v) => onProviderChange(v as 'mtn' | 'airtel')} className="grid grid-cols-2 gap-3" disabled={loading}>
          <Label htmlFor="mtn" className={`flex items-center justify-center gap-2 p-4 rounded-xl border-2 cursor-pointer transition-all ${provider === 'mtn' ? 'border-yellow-500 bg-yellow-500/10' : 'border-border hover:border-yellow-500/50'}`}>
            <RadioGroupItem value="mtn" id="mtn" className="sr-only" />
            <div className="text-center"><div className="font-bold text-yellow-600">MTN</div><div className="text-xs text-muted-foreground">090777</div></div>
          </Label>
          <Label htmlFor="airtel" className={`flex items-center justify-center gap-2 p-4 rounded-xl border-2 cursor-pointer transition-all ${provider === 'airtel' ? 'border-red-500 bg-red-500/10' : 'border-border hover:border-red-500/50'}`}>
            <RadioGroupItem value="airtel" id="airtel" className="sr-only" />
            <div className="text-center"><div className="font-bold text-red-600">Airtel</div><div className="text-xs text-muted-foreground">4380664</div></div>
          </Label>
        </RadioGroup>
      </div>

      {/* Transaction ID */}
      <div className="space-y-2">
        <Label htmlFor="transactionId" className="flex items-center gap-2">Transaction ID <span className="text-destructive">*</span></Label>
        <Input id="transactionId" type="text" placeholder={provider === 'mtn' ? 'e.g. 12345678901' : 'e.g. CI240125...'} value={transactionId} onChange={(e) => onTransactionIdChange(e.target.value.toUpperCase())} disabled={loading} className="h-12 font-mono uppercase" maxLength={30} />
        <p className="text-xs text-muted-foreground flex items-start gap-1.5">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          Enter the transaction ID from the customer's {provider.toUpperCase()} payment confirmation SMS
        </p>
      </div>

      {/* Date & Time */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="txnDate" className="flex items-center gap-1.5 text-sm"><Calendar className="h-3.5 w-3.5" /> Date</Label>
          <Input id="txnDate" type="date" value={transactionDate} onChange={(e) => onTransactionDateChange(e.target.value)} disabled={loading} className="h-12" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="txnTime" className="flex items-center gap-1.5 text-sm"><Clock className="h-3.5 w-3.5" /> Time</Label>
          <Input id="txnTime" type="time" value={transactionTime} onChange={(e) => onTransactionTimeChange(e.target.value)} disabled={loading} className="h-12" />
        </div>
      </div>

      {/* Narration */}
      <div className="space-y-2">
        <Label htmlFor="narration" className="flex items-center gap-1.5 text-sm"><Info className="h-3.5 w-3.5" /> Reason / Narration <span className="text-destructive">*</span></Label>
        <Input id="narration" type="text" placeholder="e.g. Rent repayment, Access fee, Wallet top-up" value={narration} onChange={(e) => onNarrationChange(e.target.value)} disabled={loading} className="h-12" maxLength={200} />
      </div>

      {/* Context Info */}
      <div className="rounded-xl bg-warning/10 border border-warning/30 p-3 flex items-start gap-2.5">
        <AlertCircle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
        <p className="text-xs text-muted-foreground">
          {isCustomerPaid 
            ? 'This deposit will be submitted for manager verification. The customer\'s account will be credited after approval.'
            : 'Please ensure all details match your mobile money SMS. Incorrect information may delay verification.'}
        </p>
      </div>

      {!isCustomerPaid && (
        <div className="bg-secondary/50 rounded-lg p-3 text-sm">
          <p className="text-muted-foreground">
            💡 If customer has an active rent repayment, the deposit will automatically be applied with your 5% commission deducted.
          </p>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={onClose} className="flex-1 h-12" disabled={loading}>Cancel</Button>
        <Button type="submit" className="flex-1 h-12" disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : isCustomerPaid ? 'Submit for Verification' : 'Process Deposit'}
        </Button>
      </div>
    </form>
  );
}

/* ── Success View ── */
function DepositSuccessView({ result, formatCurrency, onClose }: {
  result: NonNullable<{ success: boolean; mode: DepositMode; details?: any }>;
  formatCurrency: (v: number) => string;
  onClose: () => void;
}) {
  const isCustomerPaid = result.mode === 'customer_paid';

  return (
    <div className="space-y-4">
      <div className="text-center py-4">
        <div className={`w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-3 ${isCustomerPaid ? 'bg-blue-500/20' : 'bg-success/20'}`}>
          {isCustomerPaid 
            ? <Send className="h-8 w-8 text-blue-600" /> 
            : <ArrowDownCircle className="h-8 w-8 text-success" />}
        </div>
        <h3 className="text-lg font-semibold">
          {isCustomerPaid ? 'Submitted for Verification' : 'Deposit Complete!'}
        </h3>
        <p className="text-muted-foreground">{result.details?.user_name}</p>
        {isCustomerPaid && (
          <p className="text-xs text-muted-foreground mt-1">A manager will verify the transaction ID and credit the account.</p>
        )}
      </div>

      <div className="space-y-2 bg-secondary/50 rounded-lg p-4">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{isCustomerPaid ? 'Amount Submitted' : 'Total Deposited'}</span>
          <span className="font-mono font-semibold">{formatCurrency(result.details?.total_deposited || 0)}</span>
        </div>
        
        {!isCustomerPaid && (result.details?.auto_repayment || 0) > 0 && (
          <div className="border-t pt-2 mt-2">
            <p className="text-sm text-muted-foreground mb-2">Auto Rent Repayment:</p>
            <div className="flex justify-between text-sm">
              <span>To Landlord</span>
              <span className="font-mono">{formatCurrency(result.details?.to_landlord || 0)}</span>
            </div>
            <div className="flex justify-between text-sm text-success">
              <span>Your Commission (5%)</span>
              <span className="font-mono">+{formatCurrency(result.details?.agent_commission || 0)}</span>
            </div>
          </div>
        )}
        
        {!isCustomerPaid && (result.details?.to_wallet || 0) > 0 && (
          <div className="flex justify-between pt-2 border-t">
            <span className="text-muted-foreground">To Customer Wallet</span>
            <span className="font-mono">{formatCurrency(result.details?.to_wallet || 0)}</span>
          </div>
        )}
      </div>

      <Button onClick={onClose} className="w-full">Done</Button>
    </div>
  );
}
