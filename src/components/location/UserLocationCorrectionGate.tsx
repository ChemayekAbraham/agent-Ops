/**
 * Login-time location capture for every signed-in user.
 *
 * Mandatory: while the user's record has no approved village, the dialog opens
 * on every app load and cannot be closed until a village from the approved
 * Uganda dataset is saved (via the shared `correct_tenant_location` RPC).
 */
import { useAuth } from '@/hooks/useAuth';
import { useMyLocationCorrectionStatus, userLegacyLabel } from '@/hooks/useUserLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

export function UserLocationCorrectionGate() {
  const { user, loading } = useAuth();
  const status = useMyLocationCorrectionStatus(!!user?.id && !loading);
  const needs = !!status.data?.needs_correction;

  if (!user?.id || !needs) return null;

  return (
    <CorrectTenantLocationDialog
      open
      forced
      onOpenChange={() => {}}
      tenant={{
        id: user.id,
        name: status.data?.full_name ?? 'Your location',
        phone: status.data?.phone ?? null,
        legacyLabel: userLegacyLabel(status.data ?? {}),
        districtHint: status.data?.legacy_district ?? null,
      }}
      onCorrected={() => status.refetch()}
    />
  );
}

export default UserLocationCorrectionGate;
