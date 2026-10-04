import { useEffect } from 'react';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';

/**
 * Hook to track user presence in a specific section of a dashboard.
 * Automatically logs page_view and tracks dwell time on section switch or unmount.
 *
 * @param section Unique name of the section (e.g. 'repayments', 'wallet', 'shopping-advance')
 * @param role Active dashboard role (e.g. 'tenant', 'supporter', 'agent', 'landlord')
 */
export function useTrackSection(section: string, role?: string) {
  useEffect(() => {
    userBehaviourTracker.setSection(section, role);
  }, [section, role]);
}
