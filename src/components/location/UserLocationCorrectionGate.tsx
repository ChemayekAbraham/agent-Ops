/**
 * Login-time location capture for every signed-in user.
 *
 * Mandatory: while the user's record has no approved village, the dialog opens
 * on every app load and cannot be closed until a village from the approved
 * Uganda dataset is saved (via the shared `correct_tenant_location` RPC).
 */
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useMyLocationCorrectionStatus, userLegacyLabel } from '@/hooks/useUserLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

// Portfolio invite completion page: the partner is there to sign an addendum,
// never blocked by the mandatory location dialog.
// Funder (Supporter) dashboards never show the mandatory location dialog.
const LOCATION_EXEMPT_ROUTES = ['/partners/', '/partners-terms', '/dashboard/funder', '/supporter-earnings'];

export function UserLocationCorrectionGate() {
  const location = useLocation();
  const { user, loading, role } = useAuth();
  const exempt = role === 'supporter' || LOCATION_EXEMPT_ROUTES.some((p) => location.pathname.startsWith(p));
  const status = useMyLocationCorrectionStatus(!!user?.id && !loading && !exempt);
  const needs = !exempt && !!status.data?.needs_correction;

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
