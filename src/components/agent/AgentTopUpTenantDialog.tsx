import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, Wallet, Search, User, TrendingUp, ArrowLeft, UserPlus } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import ConfirmSummaryCard from '@/components/payments/ConfirmSummaryCard';
import { QuickRegisterTenantDialog } from './QuickRegisterTenantDialog';
import { useAgentBalances } from '@/hooks/useAgentBalances';

interface AgentTopUpTenantDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

type DialogStep = 'input' | 'confirm' | 'success';

export function AgentTopUpTenantDialog({ open, onOpenChange, onSuccess }: AgentTopUpTenantDialogProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<{ id: string; full_name: string; phone: string }[]>([]);
  const [tenantInfo, setTenantInfo] = useState<{ id: string; full_name: string; phone: string } | null>(null);
  const [step, setStep] = useState<DialogStep>('input');
  const [commissionEarned, setCommissionEarned] = useState(0);
  const [tenantRentBalance, setTenantRentBalance] = useState<number | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [showQuickRegister, setShowQuickRegister] = useState(false);
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { floatBalance, isLoading: balancesLoading, refetch: refetchBalances } = useAgentBalances();

  useEffect(() => {
    if (open) refetchBalances();
  }, [open, refetchBalances]);

  const searchTenant = async () => {
    const q = searchQuery.trim();
    if (q.length < 2) {
      toast({ title: 'Enter at least 2 characters to search', variant: 'destructive' });
      return;
    }
    setSearching(true);
    setTenantInfo(null);
    setSearchResults([]);
    setTenantRentBalance(null);

    try {
      const cleaned = q.replace(/\s/g, '');
      const isPhone = /^\+?\d{7,}$/.test(cleaned);
      let query = supabase.from('profiles').select('id, full_name, phone');

      if (isPhone) {
        // Normalize all common Uganda formats: +2567XXXXXXXX, 2567XXXXXXXX, 07XXXXXXXX, 7XXXXXXXX
        const local = cleaned.replace(/^\+?256/, '0').replace(/^([1-9]\d{8})$/, '0$1');
        const intl = '+256' + local.replace(/^0/, '');
        const intlNoPlus = '256' + local.replace(/^0/, '');
        query = query.or(`phone.eq.${local},phone.eq.${intl},phone.eq.${intlNoPlus}`);
      } else {
        query = query.ilike('full_name', `%${q}%`);
      }

      const { data, error } = await query.limit(8);
      if (error) throw error;
      if (!data || data.length === 0) {
        if (isPhone) {
          setShowQuickRegister(true);
        } else {
          toast({ title: 'No tenant found', description: `No user matching "${q}"`, variant: 'destructive' });
        }
        return;
      }
      if (data.length === 1) {
        selectTenant(data[0]);
      } else {
        setSearchResults(data);
      }
    } catch (err: any) {
      toast({ title: 'Search failed', description: err.message, variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  };

  const selectTenant = async (tenant: { id: string; full_name: string; phone: string }) => {
    setTenantInfo(tenant);
    setSearchResults([]);
    const { data } = await supabase
      .from('rent_requests')
      .select('total_repayment, amount_repaid')
      .eq('tenant_id', tenant.id)
      .in('status', ['approved', 'funded', 'disbursed', 'repaying'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      setTenantRentBalance(data.total_repayment - data.amount_repaid);
    }
  };

  const amountNum = parseFloat(amount) || 0;
  const commission = Math.round(amountNum * 0.10);
  const landlordPortion = amountNum - commission;

  const handleProceedToConfirm = () => {
    if (!tenantInfo || amountNum <= 0) return;
    if (amountNum > floatBalance) return;
    setConfirmed(false);
    setStep('confirm');
  };

  const handleTopUp = async () => {
    if (!tenantInfo || !confirmed) return;

    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('agent-deposit', {
        body: {
          user_phone: tenantInfo.phone,
          amount: amountNum,
          provider: 'wallet_topup',
          transaction_id: `TOPUP-${Date.now()}`,
        },
      });

      if (error) {
        const errMsg = error?.context ?
          await error.context.json().then((r: any) => r.error).catch(() => error.message)
          : error.message;
        throw new Error(errMsg || 'Top-up failed');
      }

      const earnedCommission = data?.details?.agent_commission || 0;
      setCommissionEarned(earnedCommission);
      setStep('success');
      
      queryClient.invalidateQueries({ queryKey: ['agent-daily-rent-expected'] });
      queryClient.invalidateQueries({ queryKey: ['agent-earnings-forecast'] });
      queryClient.invalidateQueries({ queryKey: ['wallet'] });
      
      toast({ title: `${formatUGX(amountNum)} deposited to ${tenantInfo.full_name}'s wallet` });
      onSuccess?.();
    } catch (err: any) {
      const msg = (err?.message || '').toLowerCase();
      const isNotFound =
        msg.includes('user not found') ||
        msg.includes('no customer found') ||
        msg.includes('not registered') ||
        msg.includes('must be registered');

      if (isNotFound) {
        setShowQuickRegister(true);
      } else {
        toast({ title: 'Top-up failed', description: err.message, variant: 'destructive' });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setSearchQuery('');
    setAmount('');
    setTenantInfo(null);
    setSearchResults([]);
    setStep('input');
    setCommissionEarned(0);
    setTenantRentBalance(null);
    setConfirmed(false);
    onOpenChange(false);
  };

  return (
    <>
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 'confirm' && (
              <Button variant="ghost" size="icon" className="h-7 w-7 -ml-1" onClick={() => setStep('input')}>
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <Wallet className="h-5 w-5 text-primary" />
            {step === 'confirm' ? 'Confirm Payment' : 'Pay Rent for Tenant'}
          </DialogTitle>
        </DialogHeader>

        {/* Agent's operational float (the bucket actually deducted) */}
        <div className="bg-primary/5 border border-primary/20 rounded-xl p-3 flex items-center justify-between">
          <div className="flex flex-col">
            <span className="text-sm font-medium text-foreground">Operational Float</span>
            <span className="text-[11px] text-muted-foreground">Used for tenant rent payments</span>
          </div>
          <span className="font-mono font-bold text-primary text-lg">
            {balancesLoading ? '...' : formatUGX(floatBalance)}
          </span>
        </div>

        {step === 'success' ? (
         <div className="text-center py-6 space-y-4">
             <div className="w-16 h-16 mx-auto bg-success/20 rounded-full flex items-center justify-center">
               <Wallet className="h-8 w-8 text-success" />
             </div>
             <h3 className="text-lg font-semibold">Rent Payment Successful!</h3>
             <p className="text-muted-foreground">{formatUGX(amountNum)} paid for {tenantInfo?.full_name}</p>
             
             {commissionEarned > 0 && (
               <div className="rounded-xl border-2 border-success/40 bg-success/5 p-4 space-y-1">
                 <div className="flex items-center justify-center gap-2">
                   <TrendingUp className="h-5 w-5 text-success" />
                   <span className="font-bold text-success text-lg">{formatUGX(commissionEarned)}</span>
                 </div>
                 <p className="text-xs text-muted-foreground">10% commission credited to your wallet</p>
               </div>
             )}
             
             <Button onClick={handleClose} className="w-full">Done</Button>
           </div>
        ) : step === 'confirm' ? (
          <div className="space-y-4">
            <ConfirmSummaryCard
              title="Payment Breakdown"
              items={[
                { label: 'Tenant', value: tenantInfo?.full_name || '', secondary: true },
                { label: 'Total Payment', value: formatUGX(amountNum) },
              ]}
              fees={[
                { label: 'Applied to tenant rent', value: formatUGX(landlordPortion) },
                { label: 'Your commission (10%)', value: formatUGX(commission) },
              ]}
              total={{ label: 'Deducted from Operational Float', value: formatUGX(amountNum) }}
              confirmText="I confirm this rent payment is correct"
              confirmed={confirmed}
              onConfirmChange={setConfirmed}
              showSecurityNote={false}
            />

            {tenantRentBalance !== null && tenantRentBalance > 0 && (
              <div className="bg-muted/50 rounded-lg px-3 py-2 text-xs text-muted-foreground">
                Tenant's outstanding balance after payment: <span className="font-bold text-foreground">
                  {formatUGX(Math.max(0, tenantRentBalance - amountNum))}
                </span>
              </div>
            )}

            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setStep('input')} className="flex-1 h-12" disabled={loading}>
                Back
              </Button>
              <Button
                onClick={handleTopUp}
                className="flex-1 h-12"
                disabled={loading || !confirmed}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : `Confirm ${formatUGX(amountNum)}`}
              </Button>
            </div>
          </div>
        ) : (
           <div className="space-y-4">
             {/* Step 1: Search tenant by name or phone */}
             <div className="space-y-2">
               <Label>Search Tenant (Name or Phone)</Label>
               <div className="flex gap-2">
                 <Input
                   type="text"
                   placeholder="e.g. Kiggundu Akram or 0700..."
                   value={searchQuery}
                   onChange={(e) => { setSearchQuery(e.target.value); setTenantInfo(null); setSearchResults([]); }}
                   disabled={loading}
                   className="h-12 flex-1"
                   onKeyDown={(e) => e.key === 'Enter' && searchTenant()}
                 />
                 <Button
                   type="button"
                   variant="secondary"
                   onClick={searchTenant}
                   disabled={searching || loading}
                   className="h-12 px-4"
                 >
                   {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                 </Button>
               </div>
             </div>

             {/* Search results list */}
             {searchResults.length > 1 && !tenantInfo && (
               <div className="border rounded-xl divide-y max-h-48 overflow-y-auto">
                 {searchResults.map((t) => (
                   <button
                     key={t.id}
                     onClick={() => selectTenant(t)}
                     className="w-full text-left px-4 py-3 hover:bg-muted/50 transition-colors touch-manipulation flex items-center gap-3"
                   >
                     <div className="p-1.5 rounded-full bg-primary/10">
                       <User className="h-4 w-4 text-primary" />
                     </div>
                     <div>
                       <p className="font-semibold text-sm">{t.full_name}</p>
                       <p className="text-xs text-muted-foreground">{t.phone}</p>
                     </div>
                   </button>
                 ))}
               </div>
             )}

             {/* Selected tenant */}
             {tenantInfo && (
               <div className="bg-secondary/50 rounded-xl p-4 space-y-2">
                 <div className="flex items-center gap-3">
                   <div className="p-2 rounded-full bg-primary/10">
                     <User className="h-5 w-5 text-primary" />
                   </div>
                   <div className="flex-1">
                     <p className="font-semibold">{tenantInfo.full_name}</p>
                     <p className="text-sm text-muted-foreground">{tenantInfo.phone}</p>
                   </div>
                   <Button size="sm" variant="ghost" onClick={() => { setTenantInfo(null); setTenantRentBalance(null); }} className="text-xs">
                     Change
                   </Button>
                 </div>
                 {tenantRentBalance !== null && tenantRentBalance > 0 && (
                   <div className="bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2 flex items-center justify-between">
                     <span className="text-xs text-destructive font-medium">Outstanding Rent Balance</span>
                     <span className="font-mono font-bold text-destructive">{formatUGX(tenantRentBalance)}</span>
                   </div>
                 )}
               </div>
             )}

             {/* Step 2: Amount */}
             {tenantInfo && (
               <>
                 <div className="space-y-2">
                   <Label>Amount to Pay (UGX)</Label>
                   <Input
                     type="number"
                     placeholder="e.g. 50000"
                     value={amount}
                     onChange={(e) => setAmount(e.target.value)}
                     disabled={loading}
                     min="1"
                     className="h-12"
                   />
                    {amountNum > floatBalance && amountNum > 0 && (
                      <p className="text-xs text-destructive font-medium">⚠️ Amount exceeds your Operational Float</p>
                    )}
                 </div>

                 {amountNum > 0 && (
                   <div className="bg-muted/50 rounded-lg p-3 text-sm space-y-1">
                     <div className="flex justify-between text-muted-foreground">
                       <span>Your commission (10%)</span>
                       <span className="font-semibold text-success">{formatUGX(commission)}</span>
                     </div>
                     <div className="flex justify-between text-muted-foreground">
                        <span>Applied to tenant rent</span>
                       <span className="font-semibold">{formatUGX(landlordPortion)}</span>
                     </div>
                   </div>
                 )}

                 <div className="flex gap-2">
                   <Button variant="outline" onClick={handleClose} className="flex-1 h-12" disabled={loading}>
                     Cancel
                   </Button>
                   <Button 
                     onClick={handleProceedToConfirm} 
                     className="flex-1 h-12" 
                      disabled={!amount || amountNum <= 0 || amountNum > floatBalance}
                   >
                     Review Payment
                   </Button>
                 </div>
               </>
             )}
          </div>
        )}
      </DialogContent>
    </Dialog>

    <QuickRegisterTenantDialog
      open={showQuickRegister}
      onOpenChange={setShowQuickRegister}
      prefillPhone={/^\+?\d{7,}$/.test(searchQuery.replace(/\s/g, '')) ? searchQuery.trim() : tenantInfo?.phone}
      onRegistered={(p) => {
        setShowQuickRegister(false);
        setSearchQuery(p);
        setTenantInfo(null);
        setSearchResults([]);
        // auto-search the newly registered tenant
        setTimeout(() => {
          (async () => {
            const normalized = p.replace(/^\+?256/, '0');
            const { data } = await supabase
              .from('profiles')
              .select('id, full_name, phone')
              .or(`phone.eq.${normalized},phone.eq.+256${normalized.slice(1)},phone.eq.${p}`)
              .limit(1)
              .maybeSingle();
            if (data) selectTenant(data);
          })();
        }, 100);
      }}
    />
    </>
  );
}