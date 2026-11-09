import { useQuery } from '@tanstack/react-query';
import { capabilities, type TutorialCapabilities } from './api';
import { useAuth } from '@/hooks/useAuth';
import { useAuthenticatedAudience, requireUserSession } from '@/hooks/useAuthenticatedPoll';

/** Server-decided tutorial access (ops_tutorial_my_capabilities.has_access). Errors mean no access. */
export function useTutorialAccess() {
  const { user } = useAuth();
  const ready = useAuthenticatedAudience();
  const q = useQuery<TutorialCapabilities>({
    queryKey: ['ops-tutorial-caps', user?.id],
    enabled: ready,
    queryFn: async () => {
      await requireUserSession();
      return capabilities() as Promise<TutorialCapabilities>;
    },
    staleTime: 5 * 60_000,
  });
  const caps = !ready || q.isError ? undefined : q.data;
  return { caps, hasAccess: !q.isError && caps?.has_access === true, isLoading: q.isLoading };
}
