import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { logCreditLoading } from '@/lib/creditLoadingDebug';

export interface CreditAccessLimit {
  totalLimit: number;
  baseLimit: number;
  bonusFromRatings: number;
  bonusFromReceipts: number;
  bonusFromRentHistory: number;
  bonusFromLandlordRent: number;
  bonusFromHousesListed: number;
  bonusFromPartnersOnboarded: number;
  bonusFromAgentAllocations: number;
  bonusFromSubagents: number;
}

const MIN_LIMIT = 20_000;

// Fixed display exchange rates (approximate)
const EXCHANGE_RATES: Record<string, number> = {
  UGX: 1,
  USD: 3750,
  EUR: 4100,
  GBP: 4750,
  KES: 29,
  TZS: 1.5,
  ZAR: 210,
};

export function convertFromUGX(amountUGX: number, currency: string): number {
  const rate = EXCHANGE_RATES[currency] || 1;
  return Math.round((amountUGX / rate) * 100) / 100;
}

export function formatCreditAmount(amountUGX: number, currency: string = 'UGX'): string {
  if (currency === 'UGX') {
    return `UGX ${Math.round(amountUGX).toLocaleString('en-US')}\n`;
  }
  const converted = convertFromUGX(amountUGX, currency);
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', KES: 'KES ', TZS: 'TZS ', ZAR: 'R' };
  const sym = symbols[currency] || `${currency} `;
  return `${sym}${converted.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

export const SUPPORTED_DISPLAY_CURRENCIES = Object.keys(EXCHANGE_RATES);

// Module-level cache to prevent duplicate RPC calls across component instances
const limitCache = new Map<string, { data: CreditAccessLimit; timestamp: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// Persistent localStorage cache so the tenant "bread" (rent access limit)
// renders from last-known data with no internet. View-only — never trusted
// for write decisions.
const LS_VERSION = 'v1';
const lsKey = (uid: string) => `credit_access_limit_${LS_VERSION}_${uid}`;

function loadFromLS(userId: string): CreditAccessLimit | null {
  try {
    const raw = localStorage.getItem(lsKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: CreditAccessLimit; timestamp: number };
    return parsed?.data ?? null;
  } catch {
    return null;
  }
}

function saveToLS(userId: string, data: CreditAccessLimit) {
  try {
    localStorage.setItem(lsKey(userId), JSON.stringify({ data, timestamp: Date.now() }));
  } catch {
    /* quota / private mode — ignore */
  }
}

// Event name fired whenever an action (e.g. agent float allocation) should
// force the credit-access limit card to recompute from the server.
const REFRESH_EVENT = 'credit-access-limit:refresh';

/**
 * Invalidate cached credit-access limit for a user and signal all live
 * `useCreditAccessLimit` hook instances to refetch immediately. Call this
 * after any action that changes the agent's effective advance limit
 * (allocations, repayments, bonuses, etc.).
 */
export function invalidateCreditAccessLimit(userId: string | undefined) {
  if (!userId) return;
  limitCache.delete(userId);
  try { localStorage.removeItem(lsKey(userId)); } catch { /* ignore */ }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(REFRESH_EVENT, { detail: { userId } }));
  }
}

export function useCreditAccessLimit(userId: string | undefined) {
  const cached = userId ? limitCache.get(userId) : undefined;
  const persisted = userId ? loadFromLS(userId) : null;
  // Seed module cache from localStorage on cold load so other instances
  // mounted in the same render pick up the warm value too.
  if (userId && persisted && !cached) {
    limitCache.set(userId, { data: persisted, timestamp: 0 });
  }
  const [limit, setLimit] = useState<CreditAccessLimit>(
    cached && (Date.now() - cached.timestamp < CACHE_TTL)
    ? cached.data
    : persisted ?? {
          totalLimit: MIN_LIMIT,
          baseLimit: MIN_LIMIT,
          bonusFromRatings: 0,
          bonusFromReceipts: 0,
          bonusFromRentHistory: 0,
          bonusFromLandlordRent: 0,
          bonusFromHousesListed: 0,
          bonusFromPartnersOnboarded: 0,
          bonusFromAgentAllocations: 0,
          bonusFromSubagents: 0,
        }
  );
  // If we have ANY cached value (memory or localStorage), don't show a
  // loading state — show stale data instantly, refresh in the background.
  const [loading, setLoading] = useState(
    !cached && !persisted,
  );

  // Once we have rendered real data even once, the skeleton must never
  // reappear — any later fetch is a background refresh and should be silent.
  const hasLoadedOnce = useRef<boolean>(!!cached || !!persisted);

  const fetchLimit = useCallback(async (forceFresh = false) => {
    if (!userId) return;

    // Check module-level cache first
    const existing = limitCache.get(userId);
    if (!forceFresh && existing && (Date.now() - existing.timestamp < CACHE_TTL)) {
      setLimit(existing.data);
      hasLoadedOnce.current = true;
      setLoading(false);
      logCreditLoading('cache-hit', { userId, loading: false, note: 'served from memory cache' });
      return existing.data;
    }

    // Offline: keep whatever cache we already rendered. Never spin.
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setLoading(false);
      return existing?.data ?? persisted ?? undefined;
    }

    // Only show the skeleton on a genuine cold load (never loaded before and
    // no cached/persisted value to render). Every later call is a background
    // refresh and must stay silent — flipping to the skeleton on background
    // refreshes is what made the card blink/shake.
    if (!hasLoadedOnce.current && !existing && !persisted) {
      setLoading(true);
      logCreditLoading('cold-load', { userId, loading: true, note: 'no cache — showing skeleton' });
    } else {
      logCreditLoading('background-refresh', { userId, loading: false, note: forceFresh ? 'forced refresh' : 'recalc refresh' });
    }
    try {
      // Recalculate and fetch in one go
      await supabase.rpc('recalculate_credit_limit', { p_user_id: userId });
      
      const { data } = await supabase
        .from('credit_access_limits')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();

      if (data) {
        const parsed: CreditAccessLimit = {
          totalLimit: Number(data.total_limit) || MIN_LIMIT,
          baseLimit: Number(data.base_limit) || MIN_LIMIT,
          bonusFromRatings: Number(data.bonus_from_ratings) || 0,
          bonusFromReceipts: Number(data.bonus_from_receipts) || 0,
          bonusFromRentHistory: Number(data.bonus_from_rent_history) || 0,
          bonusFromLandlordRent: Number(data.bonus_from_landlord_rent) || 0,
          bonusFromHousesListed: Number((data as any).bonus_from_houses_listed) || 0,
          bonusFromPartnersOnboarded: Number((data as any).bonus_from_partners_onboarded) || 0,
          bonusFromAgentAllocations: Number((data as any).bonus_from_agent_allocations) || 0,
          bonusFromSubagents: Number((data as any).bonus_from_subagents) || 0,
        };
        setLimit(parsed);
        hasLoadedOnce.current = true;
        limitCache.set(userId, { data: parsed, timestamp: Date.now() });
        saveToLS(userId, parsed);
        return parsed;
      }
    } catch (err) {
      console.error('[useCreditAccessLimit] Error:', err);
    } finally {
      setLoading(false);
      logCreditLoading('done', { userId, loading: false, note: 'fetch settled' });
    }
  }, [userId]);

  // Read-only fetch (NO recalculate). Used by realtime / refresh-event
  // handlers so reacting to a row change never writes back to the table —
  // which previously created an infinite recalc→write→event→recalc loop
  // that made the card flicker constantly.
  const refetchRow = useCallback(async () => {
    if (!userId) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    logCreditLoading('realtime-refetch', { userId, loading: false, note: 'row changed — silent re-read' });
    try {
      const { data } = await supabase
        .from('credit_access_limits')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle();
      if (data) {
        const parsed: CreditAccessLimit = {
          totalLimit: Number(data.total_limit) || MIN_LIMIT,
          baseLimit: Number(data.base_limit) || MIN_LIMIT,
          bonusFromRatings: Number(data.bonus_from_ratings) || 0,
          bonusFromReceipts: Number(data.bonus_from_receipts) || 0,
          bonusFromRentHistory: Number(data.bonus_from_rent_history) || 0,
          bonusFromLandlordRent: Number(data.bonus_from_landlord_rent) || 0,
          bonusFromHousesListed: Number((data as any).bonus_from_houses_listed) || 0,
          bonusFromPartnersOnboarded: Number((data as any).bonus_from_partners_onboarded) || 0,
          bonusFromAgentAllocations: Number((data as any).bonus_from_agent_allocations) || 0,
          bonusFromSubagents: Number((data as any).bonus_from_subagents) || 0,
        };
        setLimit(parsed);
        hasLoadedOnce.current = true;
        limitCache.set(userId, { data: parsed, timestamp: Date.now() });
        saveToLS(userId, parsed);
      }
    } catch (err) {
      console.error('[useCreditAccessLimit] refetchRow error:', err);
    }
  }, [userId]);

  useEffect(() => {
    fetchLimit();
  }, [fetchLimit]);

  // Listen for global "refresh" pings so the card updates the instant an
  // allocation (or any other limit-changing action) completes.
  useEffect(() => {
    if (!userId || typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { userId?: string } | undefined;
      if (!detail?.userId || detail.userId === userId) {
        limitCache.delete(userId);
        fetchLimit(true);
      }
    };
    window.addEventListener(REFRESH_EVENT, handler);
    return () => window.removeEventListener(REFRESH_EVENT, handler);
  }, [userId, fetchLimit]);

  // Cross-device realtime: subscribe to changes on the user's
  // `credit_access_limits` row. Whenever the backend recomputes the limit
  // (allocation, repayment, bonus job, manual recalc on another device),
  // every open session/device for this user refreshes its card instantly.
  // We never trust payload.new — we always re-fetch via the canonical path.
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`credit-limit-${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'credit_access_limits',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          // Re-read the row only. Do NOT recalc here — recalc writes the
          // row, which would re-trigger this same handler in a loop.
          refetchRow();
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, refetchRow]);

  const refreshLimit = useCallback(() => fetchLimit(true), [fetchLimit]);

  return { limit, loading, refreshLimit };
}
