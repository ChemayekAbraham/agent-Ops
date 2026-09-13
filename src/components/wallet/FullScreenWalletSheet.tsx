import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { useCurrency } from '@/hooks/useCurrency';
import { getDynamicCurrencyName } from '@/lib/currencyFormat';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { 
  Send, Plus, HandCoins, 
  TrendingUp,
  X, Calendar, ChevronRight,
  ChevronDown, FileDown, CreditCard,
  SlidersHorizontal
} from 'lucide-react';
import { fetchAgentWalletData } from '@/lib/fetchAgentWalletData';
import { generateAgentWalletReportPdf } from '@/lib/agentWalletReportPdf';
import { useWallet } from '@/hooks/useWallet';
import { SendMoneyDialog } from './SendMoneyDialog';
import DepositFlow from '@/components/payments/DepositFlow';
import { RequestMoneyDialog } from './RequestMoneyDialog';

import { TransactionReceipt } from './TransactionReceipt';
import { UserDepositRequests } from './UserDepositRequests';
import { UserWithdrawalRequests } from './UserWithdrawalRequests';
import { AnimatedBalance } from './AnimatedBalance';
import { NfcCardSetupDialog } from './NfcCardSetupDialog';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { UserAvatar } from '@/components/UserAvatar';
import { hapticTap } from '@/lib/haptics';

import walletRafiki3Asset from '@/assets/wallet-rafiki-3.svg.asset.json';
import { WalletLedgerStatement } from './WalletLedgerStatement';
import { PaymentMethodIcons } from './PaymentMethodIcons';
import { ProxyPartnerFunds } from '@/components/agent/ProxyPartnerFunds';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { WalletTransactionTimeline } from './WalletTransactionTimeline';
import { BillPaymentDialog } from './BillPaymentDialog';
import { FoodMarketDialog } from './FoodMarketDialog';
import { WalletDisclaimer } from './WalletDisclaimer';
import { AgentRentRequestsWalletSection } from './AgentRentRequestsWalletSection';

import { EmptyHousePlacementBonusBanner } from '@/components/agent/EmptyHousePlacementBonusBanner';
import { FloatBreakdownCard } from './FloatBreakdownCard';
import { AgentMoneyMapCard } from './AgentMoneyMapCard';


interface FullScreenWalletSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scrollTarget?: 'statement' | null;
}


export function FullScreenWalletSheet({ open, onOpenChange, scrollTarget }: FullScreenWalletSheetProps) {
  const navigate = useNavigate();
  const { wallet, transactions, loading, refreshTransactions } = useWallet();
  const { user, role } = useAuth();
  const { profile } = useProfile();
  const isAgent = role === 'agent';
  const { commissionBalance, withdrawableBalance } = useAgentBalances();
  const { floatBalance: walletFloatBalance, advanceBalance, pendingHolds } = useAgentBalances();
  const visibleAgentFloatBalance = walletFloatBalance;
  // STRICT: total visible balance is float + ledger-backed withdrawable.
  // We never use the raw cached `wallets.balance` because it can drift
  // above the user's true ledger-backed position.
  const realWithdrawableBalance = Math.max(0, withdrawableBalance);
  const displayBalance = isAgent
    ? visibleAgentFloatBalance + realWithdrawableBalance
    : realWithdrawableBalance;
  const balanceLabel = 'Total Balance';
  const [sendOpen, setSendOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [nfcCardOpen, setNfcCardOpen] = useState(false);
  const [billsOpen, setBillsOpen] = useState(false);
  const [foodMarketOpen, setFoodMarketOpen] = useState(false);
  const [selectedTransaction, setSelectedTransaction] = useState<typeof transactions[0] | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [hasProxyPartners, setHasProxyPartners] = useState(false);
  const statementSectionRef = useRef<HTMLDivElement | null>(null);

  // When opened with scrollTarget='statement', jump the Wallet Statement
  // section into view so users don't have to scroll to find it.
  useEffect(() => {
    if (!open || scrollTarget !== 'statement') return;
    const t = window.setTimeout(() => {
      statementSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 250);
    return () => window.clearTimeout(t);
  }, [open, scrollTarget]);

  // Check if the agent has proxy partners or proxy ROI entries. Custody v2
  // payouts can be approved directly to the partner wallet (target_wallet_user_id
  // is null/partner), so gating the tab only on old agent-wallet approvals hides
  // today's CFO-approved proxy partner list.
  useEffect(() => {
    const checkProxy = async () => {
      if (!user?.id) return;
      const { count } = await supabase
        .from('proxy_agent_assignments')
        .select('id', { count: 'exact', head: true })
        .eq('agent_id', user.id)
        .eq('beneficiary_role', 'supporter')
        .eq('is_active', true)
        .eq('approval_status', 'approved');
      setHasProxyPartners((count || 0) > 0);
    };
    if (open) checkProxy();
  }, [open, user?.id]);

  useEffect(() => {
    // refreshWallet() was removed here — useWallet's `wallet` figure comes
    // from useWalletBalance, which is already realtime-backed (ref-counted
    // channel), so re-fetching it on every sheet open was redundant.
    // refreshTransactions() stays: wallet_transactions has no realtime
    // subscription anywhere in the codebase, so this is its only refresh
    // trigger (confirmed by reading useWallet.ts — not a bug to leave, but
    // genuinely not something Phase 2 backs with realtime either, since
    // that phase covers deposit_requests/withdrawal_requests, not this).
    if (open) {
      refreshTransactions();
    }
  }, [open, refreshTransactions]);


  const { formatAmount: formatCurrency } = useCurrency();

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent 
          side="bottom" 
          className="h-[100dvh] p-0 rounded-none border-0 flex flex-col"
        >
          {/* Clean white top bar */}
          <div className="safe-area-top bg-background border-b border-border/40">
            <div className="flex items-center gap-3 px-4 py-3">
              <UserAvatar 
                avatarUrl={profile?.avatar_url} 
                fullName={profile?.full_name} 
                size="sm" 
              />
              <span className="text-lg font-bold text-foreground tracking-tight">Welile</span>
            </div>
          </div>

          {/* Scrollable content */}
          <div 
            className="flex-1 overflow-y-auto overscroll-contain bg-muted/30"
            style={{ WebkitOverflowScrolling: 'touch' }}
          >
            <div className="p-4 space-y-4">
              {/* Wallet Statement section */}
              <div ref={statementSectionRef} id="wallet-statement-section" className="scroll-mt-4">
                <img
                  src={walletRafiki3Asset.url}
                  alt=""
                  aria-hidden="true"
                  className="mx-auto mb-3 h-40 w-auto pointer-events-none select-none"
                />
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="text-base font-bold text-foreground">Wallet Statement</h3>
                    <p className="text-xs text-muted-foreground">Updated just now</p>
                    <PaymentMethodIcons className="mt-2" />
                  </div>
                </div>

                {/* Download Statement Button */}
                {isAgent && user?.id && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full gap-2 text-xs mb-4"
                    onClick={async () => {
                      try {
                        const data = await fetchAgentWalletData(user.id);
                        const blob = await generateAgentWalletReportPdf(data);
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `My_Wallet_Statement.pdf`;
                        a.click();
                        URL.revokeObjectURL(url);
                      } catch (e) { console.error(e); }
                    }}
                  >
                    <FileDown className="h-3.5 w-3.5" />
                    Download Wallet Statement (PDF)
                  </Button>
                )}

                {/* Ledger statement with optional proxy tab */}
                {hasProxyPartners ? (
                  <Tabs defaultValue="statement">
                    <TabsList variant="pills" className="w-full">
                      <TabsTrigger value="statement" variant="pills">Wallet Statement</TabsTrigger>
                      <TabsTrigger value="proxy" variant="pills">Proxy Partners</TabsTrigger>
                    </TabsList>
                    <TabsContent value="statement">
                      <WalletLedgerStatement />
                    </TabsContent>
                    <TabsContent value="proxy">
                      <ProxyPartnerFunds />
                    </TabsContent>
                  </Tabs>
                ) : (
                  <WalletLedgerStatement />
                )}
              </div>

              {/* Recent Transactions */}
              <WalletTransactionTimeline
                transactions={transactions}
                currentUserId={user?.id || ''}
                currentBalance={displayBalance}
                formatCurrency={formatCurrency}
                onSelectTransaction={(tx) => {
                  setSelectedTransaction(tx);
                  setReceiptOpen(true);
                }}
                onViewAll={() => {
                  onOpenChange(false);
                  navigate('/transactions');
                }}
                ownerName={profile?.full_name || undefined}
                ownerPhone={profile?.phone || undefined}
              />

              {/* Agent Rent Requests — verify inline */}
              <AgentRentRequestsWalletSection />

              {/* User's Pending Requests */}
              <UserDepositRequests />
              <UserWithdrawalRequests />

              {/* Bottom padding for safe area */}
              <div className="h-8 safe-area-bottom" />
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Dialogs */}
      <SendMoneyDialog open={sendOpen} onOpenChange={setSendOpen} />
      <DepositFlow
        open={depositOpen}
        onOpenChange={setDepositOpen}
        {...(isAgent
          ? { allowedPurposes: ['operational_float', 'personal_deposit'] as const, lockPurpose: true, requirePurposeChoice: true }
          : role === 'supporter'
            ? { allowedPurposes: ['partnership_deposit'] as const, defaultPurpose: 'partnership_deposit' as const, lockPurpose: true }
            : {})}
      />
      <RequestMoneyDialog 
        open={requestOpen} 
        onOpenChange={setRequestOpen} 
      />
      <TransactionReceipt 
        open={receiptOpen} 
        onOpenChange={setReceiptOpen} 
        transaction={selectedTransaction}
        currentUserId={user?.id || ''}
      />
      <BillPaymentDialog open={billsOpen} onOpenChange={setBillsOpen} />
      <FoodMarketDialog open={foodMarketOpen} onOpenChange={setFoodMarketOpen} />
      <NfcCardSetupDialog open={nfcCardOpen} onOpenChange={setNfcCardOpen} />
    </>
  );
}
