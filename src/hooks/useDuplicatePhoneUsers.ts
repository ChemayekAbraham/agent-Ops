import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface DuplicatePhoneData {
  duplicateUserIds: Set<string>;
  duplicateCount: number;
  duplicateGroups: Map<string, string[]>; // normalized phone -> user IDs
  loading: boolean;
  refetch: () => Promise<void>;
}

export function useDuplicatePhoneUsers(): DuplicatePhoneData {
  const [duplicateUserIds, setDuplicateUserIds] = useState<Set<string>>(new Set());
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [duplicateGroups, setDuplicateGroups] = useState<Map<string, string[]>>(new Map());
  const [loading, setLoading] = useState(true);

  const fetchDuplicates = useCallback(async () => {
    setLoading(true);
    try {
      // Use server-side function — scales to millions of users
      const { data, error } = await supabase.rpc('find_duplicate_phones');

      if (error) {
        console.error('Error detecting duplicate phones:', error);
        return;
      }

      if (!data || data.length === 0) {
        setDuplicateUserIds(new Set());
        setDuplicateCount(0);
        setDuplicateGroups(new Map());
        return;
      }

      const duplicates = new Set<string>();
      const groupsMap = new Map<string, string[]>();
      let count = 0;

      data.forEach((row: { normalized_phone: string; user_ids: string[]; user_count: number }) => {
        row.user_ids.forEach(id => duplicates.add(id));
        groupsMap.set(row.normalized_phone, row.user_ids);
        count += row.user_count;
      });

      setDuplicateUserIds(duplicates);
      setDuplicateCount(count);
      setDuplicateGroups(groupsMap);
    } catch (err) {
      console.error('Error detecting duplicate phones:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDuplicates();
  }, [fetchDuplicates]);

  return {
    duplicateUserIds,
    duplicateCount,
    duplicateGroups,
    loading,
    refetch: fetchDuplicates,
  };
}
