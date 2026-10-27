import { agentNotVettedReason } from '@/lib/agentVetting';

export const NOT_VETTED_EVENT = 'agent-not-vetted';

/**
 * If a create failed because the agent is not verified, open the global
 * "Go to verification" dialog with the server's own reason and return true.
 * Otherwise return false so the caller shows its usual error.
 */
export function promptIfNotVetted(...errs: unknown[]): boolean {
  for (const e of errs) {
    const reason = agentNotVettedReason(e);
    if (reason) {
      window.dispatchEvent(new CustomEvent(NOT_VETTED_EVENT, { detail: reason }));
      return true;
    }
  }
  return false;
}
