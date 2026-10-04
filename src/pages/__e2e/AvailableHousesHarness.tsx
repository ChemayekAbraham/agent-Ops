/**
 * Dev-only Playwright harness that mounts the tenant `AvailableHousesSheet`
 * open, with no auth required, so the Kampala house-list parity spec can drive
 * its region filter and compare the rendered list against the underlying query.
 *
 * Mounted at `/__e2e/available-houses` ONLY when `import.meta.env.DEV` is true —
 * so it never ships in production builds.
 */
import { useState } from 'react';
import { AvailableHousesSheet } from '@/components/tenant/AvailableHousesSheet';

export default function AvailableHousesHarness() {
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="e2e-available-houses-harness" className="p-6">
      <button
        data-testid="open-available-houses"
        className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-semibold"
        onClick={() => setOpen(true)}
      >
        Open available houses
      </button>
      <AvailableHousesSheet open={open} onOpenChange={setOpen} />
    </div>
  );
}
