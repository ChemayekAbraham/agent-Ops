/**
 * Identity binding — one account, one captured identity, one locked withdrawal number.
 *
 * The identity details a user submits (National ID reading, ID photo, selfie and
 * the payout number they confirmed with a code) are bound permanently to their
 * account by `complete_identity_binding`. From then on the server resolves the
 * payout destination itself: nothing the app sends can change where money goes.
 *
 * This is capture, not verification — no claim is made here that the ID was
 * checked against an authority or that the face was matched.
 */
import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface IdentityBinding {
  id: string;
  status: 'identity_captured' | 'identity_verification_pending' | 'identity_verified' | 'revoked';
  national_id: string | null;
  linked_national_id: string | null;
  full_legal_name: string | null;
  locked_payout_number: string | null;
  locked_payout_name: string | null;
  locked_payout_provider: string | null;
  submitted_at: string | null;
}

/** `+256 772 *** 456` — never show a full payout number in ordinary UI. */
export function maskPayoutNumber(raw?: string | null): string {
  const d = (raw ?? '').replace(/\D/g, '');
  if (d.length < 6) return raw ?? '';
  const local = d.startsWith('256') ? d.slice(3) : d.replace(/^0/, '');
  const head = local.slice(0, 3);
  const tail = local.slice(-3);
  return `+256 ${head} *** ${tail}`;
}

export function useIdentityBinding(userId?: string) {
  const { user } = useAuth();
  const id = userId ?? user?.id;
  return useQuery({
    queryKey: ['identity-binding', id],
    enabled: !!id,
    staleTime: 30_000,
    queryFn: async (): Promise<IdentityBinding | null> => {
      const { data, error } = await supabase
        .from('user_identity_bindings')
        .select(
          'id, status, national_id, linked_national_id, full_legal_name, locked_payout_number, locked_payout_name, locked_payout_provider, submitted_at',
        )
        .eq('user_id', id!)
        .neq('status', 'revoked')
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as IdentityBinding | null;
    },
  });
}

/**
 * Completes the binding. Safe to call more than once — the server returns
 * `already_bound` instead of touching anything.
 */
export function useCompleteIdentityBinding() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('complete_identity_binding', {
        p_ip_address: null,
        p_user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 400) : null,
      });
      if (error) throw error;
      return (data ?? {}) as {
        success?: boolean;
        code?: string;
        message?: string;
        locked_payout_number?: string | null;
      };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['identity-binding', user?.id] });
    },
  });

  /** Fire-and-forget: identity capture must never fail because binding lagged. */
  const tryComplete = useCallback(async () => {
    try {
      return await mutation.mutateAsync();
    } catch {
      return null;
    }
  }, [mutation]);

  return { ...mutation, tryComplete };
}

export default useIdentityBinding;
