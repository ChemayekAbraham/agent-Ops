import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Wallet, Send, Plus, ArrowUpRight, ArrowDownLeft, HandCoins, Bell, History, TrendingUp, TrendingDown, ArrowDownToLine, BadgeCheck } from 'lucide-react';
import { useWallet } from '@/hooks/useWallet';
import { getBalanceColorClass, getBalanceDotClass, formatSyncTime } from '@/lib/walletUtils';
import { SendMoneyDialog } from './SendMoneyDialog';
import DepositFlow from '@/components/payments/DepositFlow';
import { RequestMoneyDialog } from './RequestMoneyDialog';
import { PendingRequestsDialog } from './PendingRequestsDialog';
import { TransactionReceipt } from './TransactionReceipt';
import { UserDepositRequests } from './UserDepositRequests';
import { WithdrawRequestDialog } from './WithdrawRequestDialog';

import { AnimatedBalance } from './AnimatedBalance';
import { WalletBreakdown } from './WalletBreakdown';
import { WalletStatement } from './WalletStatement';


import { RecentAutoCharges } from './RecentAutoCharges';
import { PendingMovesStrip } from './PendingMovesStrip';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { SkeletonWallet } from '@/components/ui/skeleton';
import { fetchPendingCounts, invalidatePendingCountsCache } from '@/lib/pendingCountsCache';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';

export function WalletCard() {
  const navigate = useNavigate();
  const { wallet, transactions, loading, isOfflineData, lastSyncedAt, refreshWallet, refreshTransactions } = useWallet();
  const { user } = useAuth();
  const { profile } = useProfile();
  // Truthy "available" = LEAST(cached wallet balance, ledger net). This
  // mirrors what wallet-deduction enforces server-side, so the user only
  // ever sees a figure they can actually move. Avoids the confusing
  // "Insufficient ledger balance" error after a withdraw attempt.
  const { available, refresh: refreshAvailable } = useAvailableBalance(user?.id);
  const [sendOpen, setSendOpen] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [selectedTransaction, setSelectedTransaction] = useState<typeof transactions[0] | null>(null);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const fetchPendingCount = useCallback(async () => {
    if (!user) return;
    const counts = await fetchPendingCounts(user.id);
    setPendingCount(counts.moneyRequests);
  }, [user]);

  useEffect(() => {
    fetchPendingCount();
  }, [fetchPendingCount]);


  const handlePendingClose = (open: boolean) => {
    setPendingOpen(open);
    if (!open) {
      invalidatePendingCountsCache();
      fetchPendingCount();
      refreshWallet();
      refreshTransactions();
      void refreshAvailable();
    }
  };

  // Headline number is `available` (ledger-bounded). The cached wallet
  // figure is intentionally hidden — surfacing it confuses users when
  // it sits above their true ledger position. We still wait for the
  // wallet row to load before showing 0 to avoid a flash.
  const balance = wallet ? (available || 0) : 0;
  const dotColor = getBalanceDotClass(balance);

  if (loading && !wallet) {
    return <SkeletonWallet />;
  }

  // Calculate income/expense from recent transactions
  const recentStats = transactions.reduce(
    (acc, tx) => {
      if (tx.sender_id === user?.id) {
        acc.sent += tx.amount;
      } else {
        acc.received += tx.amount;
      }
      return acc;
    },
    { sent: 0, received: 0 }
  );

  const handleRefresh = async () => {
    await Promise.all([refreshWallet(), refreshTransactions(), fetchPendingCount(), refreshAvailable()]);
  };

  return (
    <>
      <div>
        <Card className="overflow-hidden border-border/50 shadow-lg rounded-2xl">
        {/* Header with gradient */}
        <div className="bg-gradient-to-br from-primary via-primary to-primary/85 p-4 sm:p-5 text-primary-foreground">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <div className="p-2.5 rounded-xl bg-primary-foreground/15">
                <Wallet className="h-5 w-5" />
              </div>
              <div className="flex items-center gap-2">
                <WalletBreakdown />
                <WalletStatement />
              </div>
            </div>
            <Button 
              variant="ghost" 
              size="icon" 
              className="relative h-10 w-10 text-primary-foreground hover:bg-primary-foreground/15 rounded-xl"
              onClick={() => setPendingOpen(true)}
            >
              <Bell className="h-5 w-5" />
              {pendingCount > 0 && (
                <Badge className="absolute -top-0.5 -right-0.5 h-5 w-5 p-0 flex items-center justify-center text-xs bg-warning text-warning-foreground animate-pulse">
                  {pendingCount}
                </Badge>
              )}
            </Button>
          </div>
          
          <div className="flex items-center gap-4">
            <UserAvatar 
              avatarUrl={profile?.avatar_url} 
              fullName={profile?.full_name} 
              size="md" 
            />
            <div className="flex-1">
              <p className="text-sm opacity-80 truncate font-medium">{profile?.full_name || 'User'}</p>
              <div className="flex items-center gap-2 mt-0.5">
                {/* Traffic-light dot indicator */}
                <span className={`inline-block h-3 w-3 rounded-full ${dotColor} animate-pulse`} />
                <AnimatedBalance 
                  value={balance} 
                  className="text-3xl sm:text-2xl font-bold tracking-tight block"
                />
              </div>
              {/* Zero-fees assurance — Welile wallet never deducts withdrawal
                  or deposit fees. Tiny pill so it doesn't fight the balance. */}
              <div className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded-full bg-primary-foreground/15 border border-primary-foreground/25 text-[10px] font-semibold tracking-wide">
                <BadgeCheck className="h-3 w-3" />
                Zero fees
              </div>
              {/* Sync status - subtle, non-intrusive */}
              <p className="text-[10px] opacity-60 mt-0.5">
                {isOfflineData ? '📴 Offline • ' : ''}
                Updated {formatSyncTime(lastSyncedAt)}
              </p>
            </div>
          </div>

          {/* Recent balance changes moved to CardContent for visibility */}


          {/* Quick Stats Row */}
          {transactions.length > 0 && (
            <div className="flex gap-3 mt-4 pt-3 border-t border-primary-foreground/20">
              <div className="flex items-center gap-2 flex-1">
                <div className="p-1.5 rounded-full bg-success/20">
                  <TrendingUp className="h-3.5 w-3.5 text-success" />
                </div>
                <div>
                  <p className="text-[10px] opacity-70 uppercase tracking-wide">In</p>
                  <p className="text-sm font-semibold">
                    {recentStats.received >= 1000 
                      ? `${(recentStats.received / 1000).toFixed(0)}K` 
                      : recentStats.received}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-1">
                <div className="p-1.5 rounded-full bg-destructive/20">
                  <TrendingDown className="h-3.5 w-3.5 text-destructive" />
                </div>
                <div>
                  <p className="text-[10px] opacity-70 uppercase tracking-wide">Out</p>
                  <p className="text-sm font-semibold">
                    {recentStats.sent >= 1000 
                      ? `${(recentStats.sent / 1000).toFixed(0)}K` 
                      : recentStats.sent}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
        
        <CardContent className="p-3.5 sm:p-4 space-y-3.5">
          {/* Realtime in-flight deposits/withdrawals — auto-hidden when empty. */}
          <PendingMovesStrip />

          {/* Action buttons - Large touch targets */}
          <div className="grid grid-cols-4 gap-2">
            <Button 
              onClick={() => setSendOpen(true)} 
              className="flex-col gap-1 h-auto py-3 rounded-xl active:scale-95 transition-all shadow-sm hover:shadow-md"
            >
              <Send className="h-4 w-4" />
              <span className="text-[10px] font-semibold tracking-wide">Send</span>
            </Button>
            <Button 
              onClick={() => setRequestOpen(true)} 
              variant="secondary"
              className="flex-col gap-1 h-auto py-3 rounded-xl active:scale-95 transition-all"
            >
              <HandCoins className="h-4 w-4" />
              <span className="text-[10px] font-semibold tracking-wide">Request</span>
            </Button>
            <Button 
              onClick={() => setDepositOpen(true)} 
              variant="outline" 
              className="flex-col gap-1 h-auto py-3 rounded-xl active:scale-95 transition-all border-border/60"
            >
              <Plus className="h-4 w-4" />
              <span className="text-[10px] font-semibold tracking-wide">Add</span>
            </Button>
            <Button 
              onClick={() => setWithdrawOpen(true)} 
              variant="outline" 
              className="flex-col gap-1 h-auto py-3 rounded-xl active:scale-95 transition-all border-warning/50 text-warning hover:bg-warning/10"
            >
              <ArrowDownToLine className="h-4 w-4" />
              <span className="text-[10px] font-semibold tracking-wide">Withdraw</span>
            </Button>
          </div>

          {/* Recent Auto-Deductions */}
          <RecentAutoCharges />




        </CardContent>
      </Card>
      </div>

      {/* User's Requests */}
      <UserDepositRequests />


      <SendMoneyDialog open={sendOpen} onOpenChange={setSendOpen} />
      <DepositFlow open={depositOpen} onOpenChange={setDepositOpen} />
      <RequestMoneyDialog 
        open={requestOpen} 
        onOpenChange={setRequestOpen} 
        onSuccess={fetchPendingCount}
      />
      <PendingRequestsDialog open={pendingOpen} onOpenChange={handlePendingClose} />
      <WithdrawRequestDialog 
        open={withdrawOpen} 
        onOpenChange={setWithdrawOpen} 
        walletBalance={balance}
        onSuccess={() => { refreshWallet(); void refreshAvailable(); }}
      />
      <TransactionReceipt 
        open={receiptOpen} 
        onOpenChange={setReceiptOpen} 
        transaction={selectedTransaction}
        currentUserId={user?.id || ''}
      />
    </>
  );
}