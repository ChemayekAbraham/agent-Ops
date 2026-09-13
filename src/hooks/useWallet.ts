import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from './useAuth';
import {
  cacheTransactions,
  getCachedTransactions,
} from '@/lib/offlineDataStorage';
import { useServiceValidation } from '@/core/services/useServiceValidation';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';

interface WalletTransaction {
  id: string;
  sender_id: string | null;
  recipient_id: string | null;
  amount: number;
  description: string | null;
  created_at: string;
  sender_name?: string;
  recipient_name?: string;
  sender_avatar_url?: string | null;
  recipient_avatar_url?: string | null;
  recipient_phone?: string;
}

interface Wallet {
  id: string;
  user_id: string;
  balance: number;
  /** Strict ledger-derived withdrawable balance (the only transferable bucket). */
  withdrawable: number;
  /** Operational float — company money, never transferable/withdrawable. */
  float_balance: number;
  created_at: string;
  updated_at: string;
}

type WalletProfileRow = {
  id: string;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
};

export function useWallet() {
  const { user } = useAuth();
  const { preValidateTransfer, checkBalance } = useServiceValidation();
  // Balance now comes from the canonical `useWalletBalance` hook: shared
  // React Query key + shared realtime channel + zero cross-session cache.
  // Every consumer of `useWallet` on the same page dedupes into ONE
  // wallet round-trip.
  const balance = useWalletBalance(user?.id);
  const [transactions, setTransactions] = useState<WalletTransaction[]>([]);
  const [isOfflineData, setIsOfflineData] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);

  const wallet: Wallet | null = useMemo(() => {
    if (!user?.id || balance.isLoading) return null;
    return {
      id: `strict-${user.id}`,
      user_id: user.id,
      balance: balance.withdrawable + balance.floatBalance,
      withdrawable: balance.withdrawable,
      float_balance: balance.floatBalance,
      created_at: new Date().toISOString(),
      updated_at: balance.updatedAt ?? new Date().toISOString(),
    };
  }, [user?.id, balance.isLoading, balance.withdrawable, balance.floatBalance, balance.updatedAt]);

  const refetchBalance = balance.refetch;

  const fetchWallet = useCallback(async (_force = false) => {
    await refetchBalance();
    setLastSyncedAt(new Date());
    setIsOfflineData(false);
  }, [refetchBalance]);

  const fetchTransactions = useCallback(async () => {
    if (!user) return;

    // Try cached transactions first
    try {
      const cached = await getCachedTransactions();
      if (cached.length > 0) {
        setTransactions(cached.filter(t => t.sender_id === user.id || t.recipient_id === user.id));
      }
    } catch (e) {
      console.warn('[useWallet] Cache read failed:', e);
    }

    if (!navigator.onLine) return;

    try {
      const { data, error } = await supabase
        .from('wallet_transactions')
        .select('*')
        .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .limit(5);

      if (error) {
        console.error('Error fetching transactions:', error);
        return;
      }

      if (data && data.length > 0) {
        // Filter out pool deployment transactions (admin-only visibility)
        const ADMIN_ONLY_DESCRIPTIONS = ['pool deployment'];
        const filteredData = data.filter(t =>
          !ADMIN_ONLY_DESCRIPTIONS.some(term => t.description?.toLowerCase().startsWith(term))
        );
        const userIds = [
          ...new Set(
            [...filteredData.map(t => t.sender_id), ...filteredData.map(t => t.recipient_id)]
              .filter((id): id is string => typeof id === 'string' && id.length > 0),
          ),
        ];

        const { data: profiles } = userIds.length > 0
          ? await supabase
            .from('profiles')
            .select('id, full_name, phone, avatar_url')
            .in('id', userIds)
          : { data: [] };

        const profileMap = new Map<string, WalletProfileRow>();
        ((profiles ?? []) as WalletProfileRow[]).forEach((p) => profileMap.set(p.id, p));

        const enrichedTransactions = filteredData.map(t => ({
          ...t,
          sender_name: t.sender_id ? profileMap.get(t.sender_id)?.full_name || 'Unknown' : 'System',
          recipient_name: t.recipient_id ? profileMap.get(t.recipient_id)?.full_name || 'Unknown' : 'System',
          sender_avatar_url: t.sender_id ? profileMap.get(t.sender_id)?.avatar_url ?? null : null,
          recipient_avatar_url: t.recipient_id ? profileMap.get(t.recipient_id)?.avatar_url ?? null : null,
          recipient_phone: t.recipient_id ? profileMap.get(t.recipient_id)?.phone || '' : '',
        }));

        setTransactions(enrichedTransactions);
        await cacheTransactions(enrichedTransactions);
      } else {
        setTransactions([]);
      }
    } catch (e) {
      console.warn('[useWallet] Failed to fetch transactions:', e);
    }
  }, [user?.id]);

  const sendMoney = useCallback(async (recipient: string, amount: number, description?: string) => {
    if (!user) return { error: new Error('Please log in first') };

    // `recipient` may be a resolved recipient UUID (preferred, from
    // resolve_transfer_recipient) or a raw phone number (legacy callers).
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isId = UUID_REGEX.test(recipient.trim());
    const recipientId = isId ? recipient.trim() : undefined;
    const recipientPhone = isId ? undefined : recipient;

    // Phase 4: Optional pre-validation via new service layer
    const transferCheck = preValidateTransfer({
      senderId: user.id,
      recipientId,
      recipientPhone,
      amount,
      description,
    });
    if (!transferCheck.shouldProceed) {
      return { error: new Error(transferCheck.errors?.[0] || 'Validation failed') };
    }

    // Optional balance pre-check (fail-fast) — gate on transferable
    // withdrawable only; float is company money and never transferable.
    if (wallet) {
      const balanceCheck = checkBalance(wallet.withdrawable, amount);
      if (!balanceCheck.shouldProceed) {
        return { error: new Error(balanceCheck.errors?.[0] || 'Insufficient balance') };
      }
    }
    
    try {
      const { data, error } = await supabase.functions.invoke('wallet-transfer', {
        body: {
          ...(recipientId ? { recipient_id: recipientId } : { recipient_phone: recipientPhone }),
          amount,
          description: description || 'Wallet transfer',
        },
      });

      if (error) return { error: new Error(error.message || 'Transfer failed') };
      if (data?.error) return { error: new Error(data.error) };

      // Refresh wallet after successful transfer
      await fetchWallet(true);
      return { error: null };
    } catch (e: any) {
      return { error: new Error(e.message || 'Transfer failed') };
    }
  }, [user, fetchWallet, wallet, preValidateTransfer, checkBalance]);

  const depositMoney = useCallback(async (_amount: number) => {
    // Direct client-side wallet updates are not allowed for security.
    // Use the deposit request flow instead (approve-deposit edge function).
    return { error: new Error('Direct deposits not allowed. Please use the deposit request flow.') };
  }, []);

  // One-time cleanup of legacy `wallet_*` localStorage entries left by
  // earlier releases. No polling — realtime + the canonical hook keep
  // the balance fresh.
  useEffect(() => {
    if (!user) return;
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('wallet_')) keys.push(k);
      }
      keys.forEach((k) => localStorage.removeItem(k));
    } catch {}
  }, [user]);

  const refreshWallet = useCallback(() => fetchWallet(true), [fetchWallet]);

  return {
    wallet,
    transactions,
    loading: balance.isLoading,
    isOfflineData,
    lastSyncedAt,
    sendMoney,
    depositMoney,
    refreshWallet,
    refreshTransactions: fetchTransactions,
  };
}
