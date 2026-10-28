import { CallingHub as LegacyCallingHub } from '@/components/ops/calling';
import { LandlordCallingHub } from '@/components/executive/landlord-ops/calling-hub';
import { useLandlordHubSwitch } from '@/hooks/useLandlordCallingHub';

/**
 * Landlord Ops Calling Hub route (`/landlord-ops/calling`).
 *
 * Controlled by the `landlord_hub_new` app setting (`system_config.landlord_hub_new`,
 * default ON for `landlord_ops`). When switched off, it reverses cleanly to the
 * legacy shared Calling Hub (`<LegacyCallingHub subjectType="landlord" />`)
 * without deleting or modifying the shared hub or Landlord Calling Center.
 */
export default function CallingHub() {
  const { enabled } = useLandlordHubSwitch();

  if (!enabled) {
    return <LegacyCallingHub subjectType="landlord" />;
  }

  return <LandlordCallingHub />;
}
