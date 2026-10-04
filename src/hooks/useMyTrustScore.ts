import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { generateWelileAiId } from '@/lib/welileAiId';

interface TrustSnapshot {
  score: number;
  tier: string;
  borrowing_limit_ugx: number;
}

/** Fetch the current authenticated user's own trust score (lightweight). */
export function useMyTrustScore() {
  const { user } = useAuth();
  const [snapshot, setSnapshot] = useState<TrustSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    if (!user) { setLoading(false); return; }
    (async () => {
      const aiId = generateWelileAiId(user.id);
      const { data, error } = await supabase.rpc('get_user_trust_profile', { p_ai_id: aiId });
      if (cancelled) return;
      if (!error && data) {
        const parsed = data as { trust?: TrustSnapshot };
        if (parsed?.trust) setSnapshot(parsed.trust);
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user]);

  return { snapshot, loading };
}
