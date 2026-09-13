/**
 * Login-time location correction for every signed-in user.
 *
 * Same experience agents already get for their tenants, applied to the signed-in
 * person's own record: the old typed address is shown read-only and the correct
 * place must be picked from the approved Uganda dataset. It reuses
 * `CorrectTenantLocationDialog` and the `correct_tenant_location` RPC, so a user
 * who is also a tenant has just one location record and one correction — no
 * second workflow, nothing duplicated.
 *
 * Shown once per browser session while the record is still unmapped; a saved
 * correction stops it appearing again.
 */
import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useMyLocationCorrectionStatus, userLegacyLabel } from '@/hooks/useUserLocationCorrections';
import CorrectTenantLocationDialog from '@/components/location/CorrectTenantLocationDialog';

const dismissedKey = (userId: string) => `welile.myLocationFix.closed:${userId}`;

export function UserLocationCorrectionGate() {
  const { user, loading } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    try {
      setDismissed(sessionStorage.getItem(dismissedKey(user.id)) === '1');
    } catch {
      setDismissed(false);
    }
  }, [user?.id]);

  const status = useMyLocationCorrectionStatus(!!user?.id && !loading && !dismissed);
  const needs = !!status.data?.needs_correction;

  useEffect(() => {
    if (needs && !dismissed) setOpen(true);
  }, [needs, dismissed]);

  if (!user?.id || !needs) return null;

  const close = () => {
    try {
      sessionStorage.setItem(dismissedKey(user.id), '1');
    } catch {
      /* best-effort */
    }
    setDismissed(true);
    setOpen(false);
  };

  return (
    <CorrectTenantLocationDialog
      open={open}
      onOpenChange={(v) => (v ? setOpen(true) : close())}
      tenant={{
        id: user.id,
        name: status.data?.full_name ?? 'Your location',
        phone: status.data?.phone ?? null,
        legacyLabel: userLegacyLabel(status.data ?? {}),
        districtHint: status.data?.legacy_district ?? null,
      }}
      onCorrected={close}
    />
  );
}

export default UserLocationCorrectionGate;
