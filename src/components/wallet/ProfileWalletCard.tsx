import { useState } from 'react';
import { UnifiedWalletHeroCard, type WalletRole } from '@/components/wallet/UnifiedWalletHeroCard';
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';
import { FunderQuickActions } from '@/components/supporter/FunderQuickActions';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { usePayoutsUiEnabled } from '@/hooks/usePayoutsUiEnabled';
import { useMerchantPayoutFloat } from '@/hooks/useMerchantFloat';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { hapticTap } from '@/lib/haptics';
import { toast } from 'sonner';
import { ArrowDownLeft, ArrowUpRight, Send } from 'lucide-react';
import DepositFlow from '@/components/payments/DepositFlow';
import WithdrawFlow from '@/components/payments/WithdrawFlow';
import { SendMoneyDialog } from '@/components/wallet/SendMoneyDialog';

/** Wallet card shown on "Your Profile" (moved from tenant/agent/landlord dashboards). */
export function ProfileWalletCard() {
  const { user, role } = useAuth();
  const { wallet, refreshWallet } = useWallet();
  const {
    commissionBalance,
    withdrawableBalance,
    otherBalance,
    floatBalance,
    refetch: refreshBalances,
  } = useAgentBalances();

  const [open, setOpen] = useState(false);
  const [walletScrollTarget, setWalletScrollTarget] = useState<'statement' | null>(null);

  // Quick actions modal states for Agent
  const [showQuickDeposit, setShowQuickDeposit] = useState(false);
  const [showQuickWithdraw, setShowQuickWithdraw] = useState(false);
  const [showQuickTransfer, setShowQuickTransfer] = useState(false);
  const { enabled: payoutsUiEnabled } = usePayoutsUiEnabled();

  const walletRole: WalletRole =
    role === 'agent' ? 'agent' : role === 'landlord' ? 'landlord' : role === 'supporter' ? 'supporter' : 'tenant';
  const isAgent = walletRole === 'agent';

  // Check if agent is an active cashout merchant agent
  const { data: isCashoutAgent } = useQuery({
    queryKey: ['is-cashout-agent', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('*')
        .eq('agent_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: isAgent && !!user?.id,
    retry: 2,
  });

  const isMerchant = !!isCashoutAgent;
  const { data: merchantFloat } = useMerchantPayoutFloat(isMerchant);
  const merchantReservedFloat = isMerchant
    ? Math.max(0, Number(merchantFloat?.ownReservedFloat ?? 0))
    : 0;

  const realWithdrawableBalance = Math.max(0, withdrawableBalance);
  const visibleAgentFloatBalance = floatBalance ?? 0;

  const balance = isAgent
    ? isMerchant
      ? realWithdrawableBalance
      : Math.max(0, visibleAgentFloatBalance - merchantReservedFloat) + realWithdrawableBalance
    : wallet?.balance ?? 0;

  const handleRefresh = async () => {
    await Promise.all([refreshWallet(), refreshBalances()]);
  };

  return (
    <>
      <UnifiedWalletHeroCard
        balance={balance}
        role={walletRole}
        defaultCollapsed={true}
        collapsible={true}
        {...(isAgent
          ? {
              floatBalance: isMerchant ? undefined : visibleAgentFloatBalance,
              floatReserved: isMerchant ? undefined : merchantReservedFloat,
              commissionBalance,
              withdrawableBalance: realWithdrawableBalance,
              otherBalance,
            }
          : {})}
        onOpenWallet={() => {
          setWalletScrollTarget(null);
          setOpen(true);
        }}
        onViewStatement={() => {
          setWalletScrollTarget('statement');
          setOpen(true);
        }}
        quickActions={
          isAgent ? (
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => {
                  hapticTap();
                  setShowQuickDeposit(true);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-white/20 hover:bg-white/10 active:scale-95 transition-all min-h-[44px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ArrowDownLeft className="h-4 w-4 text-white" />
                <span className="text-[11px] font-bold text-white uppercase tracking-wider">Deposit</span>
              </button>
              <button
                onClick={() => {
                  hapticTap();
                  if (payoutsUiEnabled) setShowQuickWithdraw(true);
                  else toast.info('Withdrawals are temporarily disabled.');
                }}
                disabled={!payoutsUiEnabled}
                aria-disabled={!payoutsUiEnabled}
                title={payoutsUiEnabled ? undefined : 'Withdrawals are temporarily disabled'}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border min-h-[44px] ${
                  payoutsUiEnabled
                    ? 'border-white/20 hover:bg-white/10 active:scale-95 transition-all'
                    : 'border-white/10 bg-white/5 opacity-50 cursor-not-allowed'
                }`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ArrowUpRight className="h-4 w-4 text-white" />
                <span className="text-[11px] font-bold text-white uppercase tracking-wider">Withdraw</span>
              </button>
              <button
                onClick={() => {
                  hapticTap();
                  setShowQuickTransfer(true);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-white/20 hover:bg-white/10 active:scale-95 transition-all min-h-[44px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Send className="h-4 w-4 text-white" />
                <span className="text-[11px] font-bold text-white uppercase tracking-wider">Transfer</span>
              </button>
            </div>
          ) : (
            <FunderQuickActions
              variant="hero"
              availableBalance={wallet?.balance ?? 0}
              onChanged={() => {
                refreshWallet();
              }}
            />
          )
        }
      />
      <FullScreenWalletSheet
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setWalletScrollTarget(null);
        }}
        scrollTarget={walletScrollTarget}
      />
      {isAgent && (
        <>
          <DepositFlow
            open={showQuickDeposit}
            onOpenChange={(v) => {
              setShowQuickDeposit(v);
              if (!v) handleRefresh();
            }}
            allowedPurposes={['personal_deposit', 'operational_float']}
            defaultPurpose="operational_float"
            requirePurposeChoice
          />
          <WithdrawFlow
            open={showQuickWithdraw}
            onOpenChange={(v) => {
              setShowQuickWithdraw(v);
              if (!v) handleRefresh();
            }}
            availableBalance={realWithdrawableBalance}
          />
          <SendMoneyDialog
            open={showQuickTransfer}
            onOpenChange={(v) => {
              setShowQuickTransfer(v);
              if (!v) handleRefresh();
            }}
          />
        </>
      )}
    </>
  );
}

