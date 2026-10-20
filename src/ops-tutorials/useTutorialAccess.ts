import { useQuery } from '@tanstack/react-query';
import { capabilities, type TutorialCapabilities } from './api';

/** Server-decided tutorial access (ops_tutorial_my_capabilities.has_access). Errors mean no access. */
export function useTutorialAccess() {
  const q = useQuery<TutorialCapabilities>({
    queryKey: ['ops-tutorial-caps'],
    queryFn: () => capabilities() as Promise<TutorialCapabilities>,
    staleTime: 5 * 60_000,
  });
  const caps = q.isError ? undefined : q.data;
  return { caps, hasAccess: !q.isError && caps?.has_access === true, isLoading: q.isLoading };
}
