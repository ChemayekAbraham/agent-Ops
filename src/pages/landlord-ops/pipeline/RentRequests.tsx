import { RentPipelineQueue } from '@/components/executive/RentPipelineQueue';

/**
 * `tenant_ops_approved` is the stage sitting on Landlord Ops' desk — the same
 * stage the previous Landlord Ops dashboard rendered. `stage` is required; without
 * it RentPipelineQueue has no stage config and cannot render.
 */
export default function RentRequests() {
  return <RentPipelineQueue stage="tenant_ops_approved" />;
}
