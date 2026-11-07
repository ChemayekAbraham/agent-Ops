import { useQuery } from '@tanstack/react-query';
import { fetchRequestsMissingDetails, type RequestMissingDetails } from '@/lib/agentIntakeDetails';

export const AGENT_REQUESTS_MISSING_DETAILS_KEY = 'agent-requests-missing-details';

/** The calling agent's rent requests that still lack intake details (agent_requests_missing_details). */
export function useAgentRequestsMissingDetails(agentId: string | null | undefined) {
  return useQuery<RequestMissingDetails[]>({
    queryKey: [AGENT_REQUESTS_MISSING_DETAILS_KEY, agentId],
    queryFn: fetchRequestsMissingDetails,
    enabled: !!agentId,
    staleTime: 60_000,
    retry: 1,
  });
}
