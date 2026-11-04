import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useV360Settings } from '@/hooks/useV360Plan';
import { V360NewPlansSwitch } from '@/components/v360/V360NewPlansSwitch';
import { cn } from '@/lib/utils';
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
 *
 * Collapsed by default: the header row carries the title and the ON/OFF state,
 * the explanation and the switch sit behind the toggle.
 */
export function V360StaffPricingBanner() {
  const { enabledRoles, rolesResolved } = useAuth();
  const visible = !!rolesResolved && canSeeV360StaffPricingBanner(enabledRoles);
  const canChange = !!rolesResolved && canChangeV360NewPlans(enabledRoles);
  const settings = useV360Settings(visible);
  const [open, setOpen] = useState(false);

  if (!visible) return null;

  const enabled = settings.data?.new_plans_enabled === true;
  const stateLabel = settings.isLoading ? '…' : settings.isError ? 'Unknown' : enabled ? 'ON' : 'OFF';
  const state = settings.isLoading ? 'loading' : settings.isError ? 'unknown' : enabled ? 'on' : 'off';

  return (
    <section
      className="sticky top-0 z-30 mb-4 rounded-xl border-2 border-primary/70 bg-card shadow-md ring-1 ring-primary/25"
      data-testid="v360-staff-pricing-banner"
      data-state={state}
      data-can-change={canChange ? 'yes' : 'no'}
      aria-label="360-day pricing status"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="v360-staff-pricing-details"
        className="flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left"
        data-testid="v360-staff-pricing-toggle"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ChevronRight
            className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
          <span className="truncate text-sm font-semibold text-foreground">360-day pricing for new Rent Plans</span>
        </span>
        <span
          className={cn(
            'shrink-0 rounded-md px-3 py-1 text-base font-black tracking-wide',
            settings.isError
              ? 'bg-muted text-foreground'
              : enabled
              ? 'bg-primary text-primary-foreground'
              : 'bg-foreground text-background',
          )}
          data-testid="v360-switch-state"
        >
          {stateLabel}
        </span>
      </button>

      {open && (
        <div id="v360-staff-pricing-details" className="space-y-1.5 border-t border-primary/25 px-3 py-3">
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
          {canChange && (
            <div className="pt-2">
              <V360NewPlansSwitch embedded />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
