import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { resolveAvatarUrl, subscribeAvatarUpdates } from '@/lib/avatarSync';

/**
 * Profile pictures for a batch of user ids, for lists that only carry names
 * (verification queue, decision audit log, ops tables). Presentation data
 * only — read straight from `profiles`, one round trip per page of rows, and
 * repainted the moment a new picture is published anywhere in the app.
 */
export function useUserAvatars(userIds: (string | null | undefined)[], enabled = true) {
  const queryClient = useQueryClient();

  const ids = useMemo(
    () => Array.from(new Set(userIds.filter((id): id is string => !!id))).sort(),
    [userIds],
  );

  const query = useQuery({
    queryKey: ['user-avatars', ids],
    enabled: enabled && ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Record<string, string | null>> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, avatar_url, full_name')
        .in('id', ids);
      if (error) throw error;
      const map: Record<string, string | null> = {};
      (data ?? []).forEach((row: { id: string; avatar_url: string | null }) => {
        map[row.id] = row.avatar_url ?? null;
      });
      return map;
    },
  });

  useEffect(() => {
    return subscribeAvatarUpdates(() => {
      queryClient.invalidateQueries({ queryKey: ['user-avatars'] });
    });
  }, [queryClient]);

  const avatarFor = (userId: string | null | undefined): string | null =>
    resolveAvatarUrl(userId, userId ? query.data?.[userId] ?? null : null);

  return { avatarFor, isLoading: query.isLoading };
}
