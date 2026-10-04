import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

const EDIT_ROLES = ['access_admin', 'super_admin'] as const;

export function useCanEditAccess() {
  const { user } = useAuth();
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const userId = user?.id;
    if (!userId) {
      setCanEdit(false);
      setLoading(false);
      return;
    }

    let cancelled = false;

    const check = async () => {
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', userId)
        .eq('enabled', true)
        .in('role', EDIT_ROLES);

      if (cancelled) return;

      if (error) {
        setCanEdit(false);
      } else {
        setCanEdit((data?.length ?? 0) > 0);
      }

      setLoading(false);
    };

    check();

    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  return { canEdit, loading };
}
