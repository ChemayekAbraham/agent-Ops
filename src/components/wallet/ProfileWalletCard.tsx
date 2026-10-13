import { useState } from 'react';
import { UnifiedWalletHeroCard, type WalletRole } from '@/components/wallet/UnifiedWalletHeroCard';
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';
import { FunderQuickActions } from '@/components/supporter/FunderQuickActions';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { useAgentBalances } from '@/hooks/useAgentBalances';

/** Wallet card shown on "Your Profile" (moved from tenant/agent/landlord dashboards). */
export function ProfileWalletCard() {
  const { role } = useAuth();
  const { wallet, refreshWallet } = useWallet();
  const { commissionBalance, withdrawableBalance, otherBalance, floatBalance } = useAgentBalances();
  const [open, setOpen] = useState(false);

  const walletRole: WalletRole =
    role === 'agent' ? 'agent' : role === 'landlord' ? 'landlord' : role === 'supporter' ? 'supporter' : 'tenant';
  const isAgent = walletRole === 'agent';
  const balance = isAgent ? Math.max(0, withdrawableBalance) + Math.max(0, floatBalance ?? 0) : wallet?.balance ?? 0;

  return (
    <>
      <UnifiedWalletHeroCard
        balance={balance}
        role={walletRole}
        {...(isAgent
          ? { floatBalance, commissionBalance, withdrawableBalance: Math.max(0, withdrawableBalance), otherBalance }
          : {})}
        onOpenWallet={() => setOpen(true)}
        quickActions={
          <FunderQuickActions
            variant="hero"
            availableBalance={isAgent ? Math.max(0, withdrawableBalance) : wallet?.balance ?? 0}
            onChanged={() => { refreshWallet(); }}
          />
        }
      />
      <FullScreenWalletSheet open={open} onOpenChange={setOpen} />
    </>
  );
}
