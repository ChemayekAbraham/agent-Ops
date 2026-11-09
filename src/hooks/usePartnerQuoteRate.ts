import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { readQuoteRate } from '@/lib/partnerReturnPolicy';

/**
 * A person's own monthly Returns rate for a NEW portfolio, from partner_quote_rate (Phase 2):
 *   'me'       the signed-in caller (signed-in partner screens: calculator, deploy, fund, house support)
 *   'partner'  a named partner (partner staff forms only; the database refuses anyone else)
 *
 * `rate` is null while loading, on any error, when signed out ('me') or without an id ('partner').
 * Null means "show no number": never fall back to the public new-partner rate, which is wrong for
 * an existing partner (design v2 §6.1, R2/R4). One RPC per person, shared by every screen.
 */
export const PARTNER_QUOTE_RATE_QUERY_KEY = ['partner-quote-rate'] as const;

export interface PartnerQuoteRateState {
  rate: number | null;
  isLoading: boolean;
}

export function usePartnerQuoteRate(quoteFor: 'me' | 'partner', partnerId?: string | null): PartnerQuoteRateState {
  const { user } = useAuth();
  const viewerId = user?.id ?? null;
  const target = quoteFor === 'partner' ? partnerId ?? null : viewerId;
  const enabled = !!viewerId && !!target && (quoteFor === 'me' || quoteFor === 'partner');
  const query = useQuery({
    // The viewer is part of the key: a sign-out/sign-in never reuses another person's answer.
    queryKey: [...PARTNER_QUOTE_RATE_QUERY_KEY, quoteFor, target, viewerId],
    enabled,
    // readQuoteRate never throws and answers null on any error (AUTH_REQUIRED, NOT_AUTHORIZED, ...).
    queryFn: () => readQuoteRate(supabase, quoteFor, quoteFor === 'partner' ? (target as string) : undefined),
    staleTime: 60_000,
    retry: false,
  });
  return {
    rate: enabled ? query.data ?? null : null,
    isLoading: enabled && query.isLoading,
  };
}

/** The signed-in caller's own rate for a new portfolio, deployment, house support or calculator. */
export function useOwnNewPortfolioRate(): PartnerQuoteRateState {
  return usePartnerQuoteRate('me');
}
