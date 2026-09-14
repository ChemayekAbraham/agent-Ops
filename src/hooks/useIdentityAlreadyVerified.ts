/**
 * One account, one National ID, one photo.
 *
 * Once Financial Ops has verified an account, its National ID photo and selfie
 * are final — the person must never be asked for them a second time. The same
 * rule is enforced in the database by `identity_already_verified(uuid)`, which
 * this hook reads so the screens agree with the server.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export function useIdentityAlreadyVerified() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ['identity-already-verified', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await supabase.rpc('identity_already_verified', {
        p_user_id: user!.id,
      });
      if (error) throw error;
      return data === true;
    },
  });
}

export default useIdentityAlreadyVerified;
