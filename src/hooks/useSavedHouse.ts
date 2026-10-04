import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export function useSavedHouse(houseId: string | undefined) {
  const { user } = useAuth();
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saveCount, setSaveCount] = useState(0);

  const checkSaved = useCallback(async () => {
    if (!user || !houseId) return;
    const { data } = await supabase
      .from('saved_houses')
      .select('id')
      .eq('user_id', user.id)
      .eq('house_id', houseId)
      .maybeSingle();
    setSaved(!!data);
  }, [user, houseId]);

  const fetchSaveCount = useCallback(async () => {
    if (!houseId) return;
    const { count } = await supabase
      .from('saved_houses')
      .select('id', { count: 'exact', head: true })
      .eq('house_id', houseId);
    setSaveCount(count || 0);
  }, [houseId]);

  useEffect(() => {
    checkSaved();
    fetchSaveCount();
  }, [checkSaved, fetchSaveCount]);

  const toggle = async () => {
    if (!user || !houseId) return;
    setLoading(true);
    if (saved) {
      await supabase.from('saved_houses').delete().eq('user_id', user.id).eq('house_id', houseId);
      setSaved(false);
      setSaveCount(c => Math.max(0, c - 1));
    } else {
      await supabase.from('saved_houses').insert({ user_id: user.id, house_id: houseId });
      setSaved(true);
      setSaveCount(c => c + 1);
    }
    setLoading(false);
  };

  return { saved, loading, saveCount, toggle };
}
