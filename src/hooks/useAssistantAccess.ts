import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * Whether the agent assistant is enabled for the signed-in user.
 *
 * The answer comes from the server (rollout allowlist + agent check). The UI must NEVER decide
 * this from an email or role: sign-in is phone-based, so the signed-in email is a synthetic
 * address, and anything computed in the browser can be edited. Show the assistant only when
 * `enabled` is true. It fails closed: while loading, or on any error, `enabled` is false.
 *
 * The same gate is enforced again on the server for every message, so hiding the UI is a
 * convenience, not the protection.
 */
export type AssistantAccessReason = 'ok' | 'not_enabled' | 'not_an_agent';

export function useAssistantAccess() {
  const { user } = useAuth();

  const query = useQuery({
    queryKey: ['assistant-access', user?.id ?? ''],
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    gcTime: 10 * 60_000,
    retry: 1,
    queryFn: async (): Promise<{ enabled: boolean; reason: AssistantAccessReason }> => {
      const { data, error } = await supabase.functions.invoke('agent-assistant', {
        body: { action: 'access' },
      });
      if (error) throw error;
      const reason: AssistantAccessReason =
        data?.reason === 'ok' || data?.reason === 'not_an_agent' ? data.reason : 'not_enabled';
      return { enabled: data?.enabled === true, reason };
    },
  });

  return {
    enabled: query.data?.enabled === true,
    reason: query.data?.reason ?? ('not_enabled' as AssistantAccessReason),
    isLoading: query.isLoading,
  };
}
