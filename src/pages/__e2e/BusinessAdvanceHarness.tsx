/**
 * Dev-only Playwright harness page that mounts BusinessAdvanceRequestDialog
 * in isolation. Lets the e2e suite exercise GPS capture, manual location
 * entry, and phonebook (Contact Picker) selection without booting the full
 * agent dashboard and all of its dependent queries.
 *
 * Mounted at `/__e2e/business-advance` ONLY when `import.meta.env.DEV` is
 * true — so this never ships in production builds.
 */
import { useState } from 'react';
import BusinessAdvanceRequestDialog from '@/components/agent/BusinessAdvanceRequestDialog';

export default function BusinessAdvanceHarness() {
  const [open, setOpen] = useState(true);
  return (
    <div data-testid="e2e-business-advance-harness" className="p-6">
      <button data-testid="open-dialog" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <BusinessAdvanceRequestDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}