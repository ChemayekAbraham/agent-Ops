import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

/**
 * Public assistant visibility is unconditional; only live personal telemetry is gated.
 *
 * The answer comes from the server, never from an email or role in the browser: sign-in is
 * phone-based, so the signed-in email is a synthetic address, and anything computed in the
 * browser can be edited. The server check fails closed for isAgentAccess, not launcher visibility.
 *
 * `reason` says whether this account has agent data behind the chat ('ok' vs 'not_an_agent').
 * It never hides the button — the assistant's own answers and the support route cover both.
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
    enabled: true,
    isAgentAccess: query.data?.enabled === true && query.data?.reason === 'ok',
    reason: query.data?.reason ?? ('not_enabled' as AssistantAccessReason),
    isLoading: false,
  };
}
