/**
 * Dev-only Playwright harness that reproduces the exact stacking scenario the
 * agent sees: an open find-house / rent-request style Dialog with the shared
 * EntityDetailSheet (landlord profile) opened ON TOP of it.
 *
 * Used by the visual-regression spec to snapshot that the landlord sheet
 * always paints above the dialog on mobile viewports.
 *
 * Mounted at `/__e2e/landlord-sheet-stacking` ONLY when `import.meta.env.DEV`
 * is true — so it never ships in production builds.
 */
import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EntityDetailSheet } from '@/components/executive/EntityDetailSheet';

export default function LandlordSheetStackingHarness() {
  const [sheetOpen, setSheetOpen] = useState(true);

  return (
    <div data-testid="e2e-landlord-sheet-stacking-harness" className="p-6">
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Find the house</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Search a landlord by name or phone number, then open their profile.
          </p>
          <button
            data-testid="open-landlord-sheet"
            className="mt-3 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-semibold"
            onClick={() => setSheetOpen(true)}
          >
            View landlord profile
          </button>

          <EntityDetailSheet
            open={sheetOpen}
            onClose={() => setSheetOpen(false)}
            title="Jane Landlord"
            subtitle="Sunrise Apartments"
            fullScreenOnMobile
            fields={[
              { label: 'Phone', value: '0700 123 456' },
              { label: 'Property', value: 'Sunrise Apartments' },
              { label: 'District', value: 'Kampala' },
              { label: 'Monthly rent', value: 'UGX 300,000' },
            ]}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}