import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { validateFullName } from '@/lib/authValidation';

export interface NameCompletionStatus {
  needsName: boolean;
  reason: string | null;
}

/**
 * Read-only hook that checks whether the signed-in user's stored full_name
 * passes the existing validateFullName check. Returns needsName=true when
 * validation fails, with the existing validator message as reason.
 *
 * No writes, no mutations, no bulk queries.
 */
export function useNameCompletionStatus() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['name-completion-status', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async (): Promise<NameCompletionStatus> => {
      if (!user?.id) return { needsName: false, reason: null };
      const { data, error } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle();
      if (error) throw error;
      const check = validateFullName(data?.full_name);
      return {
        needsName: !check.valid,
        reason: check.error,
      };
    },
  });
}
