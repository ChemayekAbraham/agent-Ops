import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

interface UseShortLinkOptions {
  targetPath: string;
  targetParams: Record<string, string>;
  enabled?: boolean;
}

export function useShortLink({ targetPath, targetParams, enabled = true }: UseShortLinkOptions) {
  const { user } = useAuth();

  const { data: shortUrl, isLoading } = useQuery({
    queryKey: ['short-link', user?.id, targetPath, JSON.stringify(targetParams)],
    queryFn: async () => {
      if (!user) return null;

      // jsonb equality via .eq is unreliable (key ordering / whitespace).
      // Use contains (@>) in BOTH directions so we match by content.
      const findExisting = async () => {
        const { data } = await supabase
          .from('short_links')
          .select('code, target_params')
          .eq('user_id', user.id)
          .eq('target_path', targetPath)
          .contains('target_params', targetParams as any);

        if (!data) return null;
        // Tighten match: also ensure stored params are subset of input (exact equality).
        const exact = data.find((row: any) => {
          const stored = (row.target_params ?? {}) as Record<string, string>;
          const keys = new Set([...Object.keys(stored), ...Object.keys(targetParams)]);
          for (const k of keys) {
            if (String(stored[k] ?? '') !== String(targetParams[k] ?? '')) return false;
          }
          return true;
        });
        return exact?.code ?? null;
      };

      const existingCode = await findExisting();
      if (existingCode) {
        return `${window.location.origin}/r/${existingCode}`;
      }

      // Try to create
      const { data: created, error } = await supabase
        .from('short_links')
        .insert({
          user_id: user.id,
          target_path: targetPath,
          target_params: targetParams as any,
        })
        .select('code')
        .single();

      if (!error && created) {
        return `${window.location.origin}/r/${created.code}`;
      }

      // Conflict / race — refetch by content
      const retryCode = await findExisting();
      if (retryCode) return `${window.location.origin}/r/${retryCode}`;

      throw error ?? new Error('Failed to create short link');
    },
    enabled: enabled && !!user,
    staleTime: Infinity,
  });

  return { shortUrl: shortUrl ?? '', isLoading };
}
