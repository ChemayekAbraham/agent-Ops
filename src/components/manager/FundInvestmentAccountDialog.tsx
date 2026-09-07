import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Wallet, Users, CheckCircle2, PiggyBank, Building2, Search, User, X, Shield, AlertTriangle } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

type PaymentMethod = 'wallet' | 'proxy_agent' | 'user_wallet';
type FundSource = 'withdrawable' | 'float';

interface ProxyAgentInfo {
  agentId: string;
  agentName: string;
  withdrawable: number;
  float: number;
  isManaged: boolean;
}

interface UserResult {
  id: string;
  full_name: string;
  phone: string;
}

interface FundInvestmentAccountDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  account: {
    id: string;
    portfolio_code: string;
    account_name: string | null;
    investment_amount: number;
    investor_id: string | null;
    agent_id: string;
    investor_name?: string;
    investor_verified_at?: string | null;
    investor_signup_source?: string | null;
  } | null;
  onSuccess: () => void;
}

export function FundInvestmentAccountDialog({ open, onOpenChange, account, onSuccess }: FundInvestmentAccountDialogProps) {
  const { toast } = useToast();
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('wallet');
  const [fundSource, setFundSource] = useState<FundSource>('withdrawable');
  const [saving, setSaving] = useState(false);
  const [partnerWallet, setPartnerWallet] = useState<{ withdrawable: number; float: number } | null>(null);
  const [proxyAgent, setProxyAgent] = useState<ProxyAgentInfo | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // "Any user" funding source
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<UserResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserResult | null>(null);
  const [selectedUserWallet, setSelectedUserWallet] = useState<{ withdrawable: number; float: number } | null>(null);

  const searchUsers = async (q: string) => {
    setSearchTerm(q);
    if (q.trim().length < 3) { setSearchResults([]); return; }
    setSearching(true);
    const { data } = await supabase.from('profiles').select('id, full_name, phone')
      .or(`full_name.ilike.%${q}%,phone.ilike.%${q}%`).limit(10);
    setSearchResults(data || []);
    setSearching(false);
  };

  const pickUser = async (u: UserResult) => {
    setSelectedUser(u);
    setSearchResults([]);
    setSearchTerm('');
    setSelectedUserWallet(null);
    const { data } = await supabase.from('wallets')
      .select('withdrawable_balance, float_balance').eq('user_id', u.id).maybeSingle();
    setSelectedUserWallet({
      withdrawable: data ? Number((data as any).withdrawable_balance ?? 0) : 0,
      float: data ? Number((data as any).float_balance ?? 0) : 0,
    });
  };

  // Fetch partner wallet balance AND proxy agent info when dialog opens
  useEffect(() => {
    if (!open || !account) {
      setPartnerWallet(null);
      setProxyAgent(null);
      return;
    }
    const partnerId = account.investor_id || account.agent_id;
    if (!partnerId) return;
    setLoadingBalance(true);

    const fetchData = async () => {
      try {
        // Fetch partner wallet + proxy agent assignment in parallel
        const [walletRes, proxyRes] = await Promise.all([
          supabase.from('wallets').select('withdrawable_balance, float_balance').eq('user_id', partnerId).maybeSingle(),
          supabase.from('proxy_agent_assignments')
            .select('agent_id, is_managed_account')
            .eq('beneficiary_id', partnerId)
            .eq('is_active', true)
            .eq('approval_status', 'approved')
            .limit(1)
            .maybeSingle(),
        ]);

        setPartnerWallet({
          withdrawable: walletRes.data ? Number((walletRes.data as any).withdrawable_balance ?? 0) : 0,
          float: walletRes.data ? Number((walletRes.data as any).float_balance ?? 0) : 0,
        });

        if (proxyRes.data?.agent_id) {
          // Fetch agent profile + wallet
          const [profileRes, agentWalletRes] = await Promise.all([
            supabase.from('profiles').select('full_name').eq('id', proxyRes.data.agent_id).single(),
            supabase.from('wallets').select('withdrawable_balance, float_balance').eq('user_id', proxyRes.data.agent_id).maybeSingle(),
          ]);
          setProxyAgent({
            agentId: proxyRes.data.agent_id,
            agentName: profileRes.data?.full_name || 'Agent',
            withdrawable: agentWalletRes.data ? Number((agentWalletRes.data as any).withdrawable_balance ?? 0) : 0,
            float: agentWalletRes.data ? Number((agentWalletRes.data as any).float_balance ?? 0) : 0,
            isManaged: !!(proxyRes.data as any).is_managed_account,
          });
        } else {
          setProxyAgent(null);
        }
      } catch {
        setPartnerWallet(null);
        setProxyAgent(null);
      } finally {
        setLoadingBalance(false);
      }
    };
    fetchData();
  }, [open, account]);

  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setAmount('');
      setNotes('');
      setPaymentMethod('wallet');
      setFundSource('withdrawable');
      setSelectedUser(null);
      setSelectedUserWallet(null);
      setSearchTerm('');
      setSearchResults([]);
    }
    setConfirming(false);
    onOpenChange(isOpen);
  };

  // The server only routes funds to the managed proxy agent's wallet when the
  // operator did NOT explicitly pick a wallet (partner wallet or a searched
  // user's wallet). Mirror that here so the balance shown and the sufficiency
  // check match the wallet that will actually be debited.
  const managedProxyOverride = !!proxyAgent?.isManaged &&
    paymentMethod !== 'wallet' &&
    paymentMethod !== 'user_wallet';
  const proxyWallet = proxyAgent ? { withdrawable: proxyAgent.withdrawable, float: proxyAgent.float } : null;
  const activeWallet = managedProxyOverride
    ? proxyWallet
    : paymentMethod === 'wallet'
      ? partnerWallet
      : paymentMethod === 'user_wallet'
        ? selectedUserWallet
        : proxyWallet;

  const selectedBalance = activeWallet
    ? (fundSource === 'withdrawable' ? activeWallet.withdrawable : activeWallet.float)
    : null;
  const parsedAmount = parseFloat(amount) || 0;
  const insufficient = selectedBalance !== null && parsedAmount > selectedBalance;

  const handleSubmit = async () => {
    if (!account || !amount) return;
    const topUpAmount = parseFloat(amount);
    if (isNaN(topUpAmount) || topUpAmount <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    if (topUpAmount < 1000) {
      toast({ title: 'Minimum top-up is UGX 1,000', variant: 'destructive' });
      return;
    }
    if (notes.trim().length < 10) {
      toast({ title: 'Please add a reason (min 10 characters)', variant: 'destructive' });
      return;
    }
    if (paymentMethod === 'proxy_agent' && !proxyAgent) {
      toast({ title: 'No proxy agent assigned', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      const { data, error } = await supabase.functions.invoke('manager-portfolio-topup', {
        body: {
          portfolio_id: account.id,
          amount: topUpAmount,
          notes: notes.trim(),
          payment_method: paymentMethod,
          fund_source: fundSource,
          source_wallet_user_id: paymentMethod === 'proxy_agent' ? proxyAgent?.agentId : undefined,
        },
      });

      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);

      toast({
        title: `${formatUGX(topUpAmount)} top-up processed`,
        description: `Deducted from ${paymentMethod === 'wallet' ? 'partner' : proxyAgent?.agentName + "'s"} ${fundSource === 'float' ? 'operational float' : 'personal deposit'}. Applied at maturity.`,
      });
      setAmount('');
      setNotes('');
      onSuccess();
      onOpenChange(false);
    } catch (e: any) {
      toast({ title: 'Top-up failed', description: e.message, variant: 'destructive' });
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  // Cleared = explicitly verified OR a legacy partner who predates the
  // self-registration (/partner-onboarding) verification flow. Only
  // self-registered funders (signup_source = 'funder-onboarding') require an
  // explicit verification — mirrors the backend gates so the UI never blocks
  // a partner the server would allow.
  const funderCleared = !!account &&
    (!!account.investor_verified_at || account.investor_signup_source !== 'funder-onboarding');

  const canSubmit = !saving && parsedAmount >= 1000 && notes.trim().length >= 10 && !insufficient &&
    (paymentMethod === 'wallet' || !!proxyAgent) &&
    funderCleared;

  const sourceOwnerLabel = managedProxyOverride
    ? `${proxyAgent?.agentName || 'Agent'} (Proxy)`
    : paymentMethod === 'wallet'
    ? (account?.investor_name || 'Partner')
    : paymentMethod === 'user_wallet'
      ? (selectedUser?.full_name || 'User')
      : `${proxyAgent?.agentName || 'Agent'} (Proxy)`;
  const sourceBucketLabel = fundSource === 'float' ? 'Operational Float' : 'Personal Deposit';

  const PAYMENT_OPTIONS: { value: PaymentMethod; label: string; icon: typeof Wallet; description: string; disabled?: boolean }[] = [
    { value: 'wallet', label: 'Wallet', icon: Wallet, description: 'Partner wallet' },
    { value: 'proxy_agent', label: 'Proxy Agent', icon: Users, description: proxyAgent ? proxyAgent.agentName : 'No agent assigned', disabled: !proxyAgent },
  ];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Portfolio Top-Up
          </DialogTitle>
        </DialogHeader>

        {account && !confirming && (
          <div className="space-y-4 py-2">
            {/* Verification status banner */}
            {!funderCleared && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="text-xs">
                  <p className="font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1">
                    <Shield className="h-3 w-3" /> Top-up blocked — funder not verified
                  </p>
                  <p className="text-muted-foreground mt-0.5 leading-relaxed">
                    {`${account.investor_name || 'This partner'} self-registered and is awaiting Partner Ops approval. Verify them before any portfolio top-up.`}
                  </p>
                </div>
              </div>
            )}

            {/* Portfolio info */}
            <div className="rounded-lg border border-primary/20 p-3 bg-primary/5">
              <p className="text-sm font-semibold text-foreground">{account.account_name || account.portfolio_code}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {account.investor_name && <span className="font-medium">{account.investor_name} · </span>}
                Current Capital: {formatUGX(account.investment_amount)}
              </p>
            </div>

            {/* Payment method selector */}
            <div className="space-y-1.5">
              <Label className="text-xs">Funding Source</Label>
              <div className="grid grid-cols-2 gap-2">
                {PAYMENT_OPTIONS.map(opt => {
                  const Icon = opt.icon;
                  const selected = paymentMethod === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      disabled={opt.disabled}
                      onClick={() => setPaymentMethod(opt.value)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-all text-center",
                        opt.disabled
                          ? "border-border bg-muted/30 opacity-50 cursor-not-allowed"
                          : selected
                            ? "border-primary bg-primary/10 shadow-sm"
                            : "border-border bg-background hover:border-muted-foreground/30 cursor-pointer"
                      )}
                    >
                      <Icon className={cn("h-4 w-4", selected ? "text-primary" : "text-muted-foreground")} />
                      <span className={cn("text-xs font-medium", selected ? "text-primary" : "text-muted-foreground")}>{opt.label}</span>
                      <span className="text-[10px] text-muted-foreground">{opt.description}</span>
                    </button>
                  );
                })}
              </div>

              {/* Bucket (deploy from) selector */}
              <Label className="text-xs mt-2 block">Deploy From</Label>
              <div className="grid grid-cols-2 gap-2">
                {([
                  { value: 'withdrawable' as FundSource, label: 'Personal Deposit', icon: PiggyBank, bal: activeWallet?.withdrawable },
                  { value: 'float' as FundSource, label: 'Operational Float', icon: Building2, bal: activeWallet?.float },
                ]).map(opt => {
                  const Icon = opt.icon;
                  const selected = fundSource === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFundSource(opt.value)}
                      className={cn(
                        "flex flex-col items-center gap-1 rounded-lg border-2 p-2.5 transition-all text-center cursor-pointer",
                        selected
                          ? "border-primary bg-primary/10 shadow-sm"
                          : "border-border bg-background hover:border-muted-foreground/30"
                      )}
                    >
                      <Icon className={cn("h-4 w-4", selected ? "text-primary" : "text-muted-foreground")} />
                      <span className={cn("text-xs font-medium", selected ? "text-primary" : "text-muted-foreground")}>{opt.label}</span>
                      <span className="text-[10px] font-semibold text-foreground">
                        {loadingBalance ? '...' : opt.bal !== undefined ? formatUGX(opt.bal) : '—'}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Selected balance display */}
              <div className="mt-1.5 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {fundSource === 'float' ? 'Operational Float' : 'Personal Deposit'} available
                </span>
                <span className="text-sm font-bold text-foreground">
                  {loadingBalance ? '...' : selectedBalance !== null ? formatUGX(selectedBalance) : '—'}
                </span>
              </div>
            </div>

            {/* Amount */}
            <div className="space-y-1.5">
              <Label className="text-xs">Amount (UGX)</Label>
              <Input
                type="number"
                min={1000}
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="e.g. 5,000,000"
                className="h-9"
                autoFocus
              />
              {insufficient && (
                <p className="text-[10px] text-destructive font-medium">
                  Insufficient wallet balance ({formatUGX(selectedBalance || 0)} available)
                </p>
              )}
            </div>

            {/* Notes */}
            <div className="space-y-1.5">
              <Label className="text-xs">Reason (required, min 10 chars)</Label>
              <Input value={notes} onChange={e => setNotes(e.target.value)} placeholder="Reason for this portfolio top-up" className="h-9" />
            </div>

            {/* Preview */}
            {parsedAmount >= 1000 && notes.trim().length >= 10 && !insufficient && (
              <div className="rounded-lg bg-accent/50 border border-accent p-3 space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Top-up amount</span>
                  <span className="font-bold text-foreground">{formatUGX(parsedAmount)}</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Source</span>
                  <span className="font-medium text-foreground">
                    {(paymentMethod === 'wallet' ? 'Partner' : `${proxyAgent?.agentName} (Proxy)`)} · {fundSource === 'float' ? 'Operational Float' : 'Personal Deposit'}
                  </span>
                </div>
                <div className="flex items-start gap-1.5 pt-1 border-t border-border/50">
                  <CheckCircle2 className="h-3 w-3 text-primary mt-0.5 shrink-0" />
                  <p className="text-[10px] text-muted-foreground">
                    Instant deduction — funds will be applied to portfolio capital at maturity.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Confirmation summary step */}
        {account && confirming && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-3">
              <p className="text-sm font-semibold text-foreground flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" /> Confirm Top-Up
              </p>
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Portfolio</span>
                  <span className="font-medium text-foreground text-right">{account.account_name || account.portfolio_code}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Top-up amount</span>
                  <span className="font-bold text-foreground">{formatUGX(parsedAmount)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">From</span>
                  <span className="font-medium text-foreground text-right">{sourceOwnerLabel}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Bucket</span>
                  <span className="font-medium text-foreground text-right">{sourceBucketLabel}</span>
                </div>
                <div className="flex justify-between text-xs border-t border-border/50 pt-2">
                  <span className="text-muted-foreground">New portfolio capital</span>
                  <span className="font-bold text-foreground">{formatUGX(account.investment_amount + parsedAmount)}</span>
                </div>
                <div className="flex justify-between text-xs items-start gap-2">
                  <span className="text-muted-foreground shrink-0">Reason</span>
                  <span className="font-medium text-foreground text-right break-words">{notes.trim()}</span>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground leading-relaxed border-t border-border/50 pt-2">
                Funds are deducted instantly and parked until the next ROI cycle. If you cancel the top-up later, the full amount is returned to this source wallet.
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={saving}>Back</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
                Confirm Top-Up
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setConfirming(true)} disabled={!canSubmit}>
                {!funderCleared ? 'Blocked — Funder Not Verified' : 'Review Top-Up'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
