import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { EntityDetailSheet } from './EntityDetailSheet';

// Force the full-screen mobile branch so we test the exact mobile path.
vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => true,
}));

/** Pull the numeric value out of a Tailwind `z-[NNN]` arbitrary class. */
function zIndexOf(el: Element | null): number {
  if (!el) return NaN;
  const match = el.className.match(/z-\[(\d+)\]/);
  return match ? Number(match[1]) : NaN;
}

describe('EntityDetailSheet — stacks above the find-house dialog (mobile)', () => {
  it('renders the landlord sheet above an open rent-request dialog', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Find the house</DialogTitle>
          <EntityDetailSheet
            open
            onClose={() => {}}
            title="Jane Landlord"
            subtitle="Sunrise Apartments"
            fullScreenOnMobile
          />
        </DialogContent>
      </Dialog>,
    );

    const dialogContent = document.querySelector('.app-dialog-content') as HTMLElement;
    const sheetContent = screen.getByRole('dialog') as HTMLElement; // the bottom sheet
    expect(dialogContent).toBeTruthy();
    expect(sheetContent).toBeTruthy();

    // 1) Both must portal to <body> as siblings — neither is nested inside the
    //    other, so no parent stacking context can trap the sheet behind the dialog.
    expect(dialogContent.closest('.app-dialog-content')).toBe(dialogContent);
    expect(sheetContent.closest('.app-dialog-content')).toBeNull();
    expect(dialogContent.contains(sheetContent)).toBe(false);

    // 2) The sheet content and its overlay must outrank the dialog content/overlay.
    const dialogOverlay = document.querySelector('[class*="z-[140]"]');
    const sheetOverlay = document.querySelector('[class*="z-[155]"]');
    const dialogZ = zIndexOf(dialogContent); // z-[150]
    const sheetZ = zIndexOf(sheetContent);   // z-[160]

    expect(sheetZ).toBeGreaterThan(dialogZ);
    expect(zIndexOf(sheetOverlay)).toBeGreaterThan(zIndexOf(dialogOverlay));
    expect(zIndexOf(sheetOverlay)).toBeGreaterThan(dialogZ);
  });
});