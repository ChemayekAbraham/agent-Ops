/**
 * Reads the database's own double-submission verdict for one account so the
 * Verify Payouts screen can show exactly why the case was grouped there:
 * which account holds the ID or phone number first, and what its ID / number is.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DoubleSubmissionReason = {
  is_double: boolean;
  kind: 'national_id' | 'phone' | null;
  first_user_id: string | null;
  first_name: string | null;
  first_phone: string | null;
  first_national_id: string | null;
  first_created_at: string | null;
};

export function useDoubleSubmissionReason(userId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['double-submission-reason', userId],
    enabled: !!userId && enabled,
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<DoubleSubmissionReason | null> => {
      const { data, error } = await supabase.rpc('identity_double_submission', {
        p_user_id: userId as string,
      });
      if (error) throw error;
      const raw = (data ?? null) as Record<string, unknown> | null;
      if (!raw) return null;
      return {
        is_double: raw.is_double === true,
        kind: (raw.kind as DoubleSubmissionReason['kind']) ?? null,
        first_user_id: (raw.first_user_id as string) ?? null,
        first_name: (raw.first_name as string) ?? null,
        first_phone: (raw.first_phone as string) ?? null,
        first_national_id: (raw.first_national_id as string) ?? null,
        first_created_at: (raw.first_created_at as string) ?? null,
      };
    },
  });
}
