/**
 * useAvailableBalance — thin wrapper over the canonical `useWalletBalance`.
 *
 * Keeps the legacy return shape (`available`, `walletCached`, `ledgerNet`,
 * `hasDrift`, `restrictedHeld`, `refresh`) so existing call sites keep
 * working, but all reads now dedupe into a single shared query key
 * (`['wallet-view', userId]`). No independent fetch, no independent
 * realtime channel — the canonical hook owns both.
 */
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';

export interface AvailableBalance {
  available: number;
  walletCached: number;
  ledgerNet: number;
  hasDrift: boolean;
  restrictedHeld: number;
}

export function useAvailableBalance(userId?: string) {
  const { user } = useAuth();
  const targetId = userId ?? user?.id;
  const w = useWalletBalance(targetId);
  const available = w.withdrawable;
  const walletCached = available + w.pendingHolds + w.restrictedHeld;
  return {
    available,
    walletCached,
    ledgerNet: walletCached,
    hasDrift: w.pendingHolds > 0,
    restrictedHeld: w.restrictedHeld,
    loading: w.isLoading,
    refresh: w.refetch,
  };
}