import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Home } from 'lucide-react';
import { CollapsibleAgentSection } from './CollapsibleAgentSection';
import { AgentRentRequestsManager } from './AgentRentRequestsManager';

interface CollapsibleRentRequestsProps {
  isOpen?: boolean;
  onToggle?: () => void;
}

export function CollapsibleRentRequests({ isOpen, onToggle }: CollapsibleRentRequestsProps) {
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    fetchPendingCount();
    // Realtime removed — rent_requests not in realtime whitelist
  }, []);

  const fetchPendingCount = async () => {
    const { count } = await supabase
      .from('rent_requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    
    setPendingCount(count || 0);
  };

  return (
    <CollapsibleAgentSection
      icon={Home}
      label="Rent Requests"
      pendingCount={pendingCount}
      pendingLabel="pending"
      iconColor="text-primary"
      isOpen={isOpen}
      onToggle={onToggle}
    >
      <AgentRentRequestsManager />
    </CollapsibleAgentSection>
  );
}
