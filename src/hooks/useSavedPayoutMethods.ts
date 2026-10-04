import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * Shape of a row in `saved_payout_methods`. Mirrors the table schema; fields
 * are nullable based on `payout_mode` (mobile-money rows fill the momo_*
 * columns, bank rows fill the bank_* columns, cash rows fill neither).
 */
export interface SavedPayoutMethod {
  id: string;
  user_id: string;
  payout_mode: 'mobile_money' | 'bank_transfer' | 'cash';
  nickname: string | null;
  momo_provider: 'MTN' | 'Airtel' | null;
  momo_number: string | null;
  momo_name: string | null;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  is_default: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Returns the current user's saved payout destinations, ordered with the
 * default first then most-recently-used. Also exposes mutations to add,
 * touch (mark-used), and delete a method.
 *
 * Designed for the WithdrawFlow "Saved methods" picker — keeps users from
 * re-typing MoMo / bank details on every cash-out.
 */
export function useSavedPayoutMethods() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const userId = user?.id ?? null;

  const list = useQuery({
    queryKey: ['saved-payout-methods', userId],
    enabled: !!userId,
    queryFn: async (): Promise<SavedPayoutMethod[]> => {
      const { data, error } = await supabase
        .from('saved_payout_methods' as never)
        .select('*')
        .eq('user_id', userId as string)
        .order('is_default', { ascending: false })
        .order('last_used_at', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as SavedPayoutMethod[];
    },
  });

  /** Insert a new payout method for the current user. */
  const create = useMutation({
    mutationFn: async (
      input: Omit<SavedPayoutMethod, 'id' | 'user_id' | 'created_at' | 'updated_at' | 'last_used_at'>,
    ) => {
      if (!userId) throw new Error('Not authenticated');
      const { data, error } = await supabase
        .from('saved_payout_methods' as never)
        .insert({ ...input, user_id: userId } as never)
        .select('*')
        .single();
      if (error) throw error;
      return data as unknown as SavedPayoutMethod;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-payout-methods', userId] }),
  });

  /** Bump `last_used_at` so the picker shows recently-used methods first. */
  const touch = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('saved_payout_methods' as never)
        .update({ last_used_at: new Date().toISOString() } as never)
        .eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-payout-methods', userId] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('saved_payout_methods' as never).delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['saved-payout-methods', userId] }),
  });

  return { ...list, create, touch, remove };
}