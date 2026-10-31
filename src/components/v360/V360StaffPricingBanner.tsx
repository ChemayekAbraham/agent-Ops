import { useAuth } from '@/hooks/useAuth';
import { useV360Settings } from '@/hooks/useV360Plan';
import { V360NewPlansSwitch } from '@/components/v360/V360NewPlansSwitch';
import {
  V360_STAFF_PRICING_CONTROL,
  V360_STAFF_PRICING_MEANING,
  canChangeV360NewPlans,
  canSeeV360StaffPricingBanner,
} from '@/lib/v360StaffAccess';

/**
 * Staff-only 360-day pricing status. Returns null for customer roles.
 * CFO, COO and super admin also get the existing confirm switch.
 * Does not change new_plans_enabled by itself.
 */
export function V360StaffPricingBanner() {
  const { enabledRoles, rolesResolved } = useAuth();
  const visible = !!rolesResolved && canSeeV360StaffPricingBanner(enabledRoles);
  const canChange = !!rolesResolved && canChangeV360NewPlans(enabledRoles);
  const settings = useV360Settings(visible);

  if (!visible) return null;

  const enabled = settings.data?.new_plans_enabled === true;
  const stateLabel = settings.isLoading ? '…' : settings.isError ? 'Unknown' : enabled ? 'ON' : 'OFF';
  const state = settings.isLoading ? 'loading' : settings.isError ? 'unknown' : enabled ? 'on' : 'off';

  return (
    <section
      className="sticky top-0 z-30 mb-4 rounded-xl border-2 border-primary/70 bg-card p-4 shadow-md ring-1 ring-primary/25"
      data-testid="v360-staff-pricing-banner"
      data-state={state}
      data-can-change={canChange ? 'yes' : 'no'}
      aria-label="360-day pricing status"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-sm font-semibold text-foreground">360-day pricing for new Rent Plans</p>
          <p className="text-sm font-medium text-foreground">{V360_STAFF_PRICING_MEANING}</p>
          <p className="text-xs text-muted-foreground">
            {canChange
              ? 'You can change this here. It stays as it is until you confirm. Existing Rent Plans are not repriced, and this does not post ledger entries.'
              : V360_STAFF_PRICING_CONTROL}
          </p>
          {settings.isError && (
            <p className="text-xs text-destructive">
              The live status could not be read. Do not assume it is off. CFO, COO or super admin can confirm it. Existing Rent Plans are not repriced.
            </p>
          )}
          {settings.isLoading && (
            <p className="text-xs text-muted-foreground">Reading the status.</p>
          )}
          {settings.data?.updated_at && (
            <p className="text-[11px] text-muted-foreground">
              Last change {new Date(settings.data.updated_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' })} EAT
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <span
            className={`rounded-md px-3 py-1.5 text-lg font-black tracking-wide ${
              settings.isError
                ? 'bg-muted text-foreground'
                : enabled
                ? 'bg-primary text-primary-foreground'
                : 'bg-foreground text-background'
            }`}
            data-testid="v360-switch-state"
          >
            {stateLabel}
          </span>
          {canChange && <V360NewPlansSwitch embedded />}
        </div>
      </div>
    </section>
  );
}
