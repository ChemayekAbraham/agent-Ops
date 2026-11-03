import { useEffect } from 'react';
import { AgentWelileHomesSheet } from '@/components/agent/AgentWelileHomesSheet';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';

/**
 * Welile Homes dedicated agent page.
 * Displays agent-managed tenant subscriptions, 2% commissions, collections,
 * float requests, and landlord grouping on a fresh page.
 */
export default function AgentWelileHomesPage() {
  useEffect(() => {
    userBehaviourTracker.setSection('agent-welile-homes', 'agent');
  }, []);

  return <AgentWelileHomesSheet isPage />;
}
