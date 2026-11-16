import { useLocation } from 'react-router-dom';
import { RentPipelineQueue } from '@/components/executive/RentPipelineQueue';

export default function Hidden() {
  const location = useLocation();
  const focusFirst = Boolean((location.state as { focusFirstRequest?: boolean } | null)?.focusFirstRequest);

  return (
    <RentPipelineQueue
      stage="tenant_ops_approved"
      viewMode="queue-only"
      focusFirstOnMount={focusFirst}
    />
  );
}
