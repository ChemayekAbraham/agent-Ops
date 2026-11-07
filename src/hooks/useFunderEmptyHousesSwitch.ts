import { useAuthenticatedAudience } from '@/hooks/useAuthenticatedPoll';

/** Discovery only: empty houses are visible pending verification.
 * This does not authorize funding; the server still enforces the funding pause.
 */
export function useFunderEmptyHousesAllowed(): boolean {
  return useAuthenticatedAudience();
}