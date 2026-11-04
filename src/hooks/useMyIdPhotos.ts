import { useQuery } from '@tanstack/react-query';
import { identityPhotoUrl } from '@/hooks/useIdentityPhotos';
import type { VettingNationalId } from '@/lib/agentVetting';

/**
 * Short-lived links for the agent's own National ID photos, for the Identity
 * step summary. The paths come from get_my_agent_vetting (national_id) and sit
 * in the agent's own folder of the private identity-verification bucket.
 */
export function useMyIdPhotos(id: VettingNationalId | null | undefined) {
  const front = id?.front_path ?? null;
  const back = id?.back_path ?? null;
  return useQuery({
    queryKey: ['agent-vetting-own-id-photos', front, back],
    enabled: !!(front || back),
    staleTime: 4 * 60_000, // links last 5 minutes
    queryFn: async () => {
      const [frontUrl, backUrl] = await Promise.all([identityPhotoUrl(front), identityPhotoUrl(back)]);
      return { front: frontUrl, back: backUrl };
    },
  });
}
