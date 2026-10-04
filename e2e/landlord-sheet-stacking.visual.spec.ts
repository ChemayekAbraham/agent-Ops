import { test, expect, devices } from '@playwright/test';

/**
 * Visual regression: the shared EntityDetailSheet (landlord profile) must
 * always paint ABOVE the find-house / rent-request Dialog on mobile.
 *
 * Regression guard for the z-index fix where the sheet (z-[160]/overlay
 * z-[155]) outranks the dialog (z-[150]/overlay z-[140]).
 *
 * We render the dedicated dev-only harness at /__e2e/landlord-sheet-stacking
 * so the snapshot is deterministic (no live data / network).
 *
 * First run creates the baseline:
 *   bunx playwright test landlord-sheet-stacking.visual --update-snapshots
 */

/**
 * Base portrait viewports across a spread of mobile sizes (small → large).
 * Each one is also exercised in landscape (width/height swapped) so the
 * full-screen sheet stacking is verified in both orientations.
 */
const BASE_VIEWPORTS = [
  { name: 'iphone-12', ...devices['iPhone 12'].viewport },
  { name: 'iphone-se', ...devices['iPhone SE'].viewport },
  { name: 'iphone-14-pro-max', ...devices['iPhone 14 Pro Max'].viewport },
  { name: 'pixel-5', ...devices['Pixel 5'].viewport },
  { name: 'pixel-7', ...devices['Pixel 7'].viewport },
  { name: 'galaxy-s9', ...devices['Galaxy S9+'].viewport },
  { name: 'small-360', width: 360, height: 740 },
  { name: 'tiny-320', width: 320, height: 568 },
];

type Orientation = 'portrait' | 'landscape';

const MOBILE_VIEWPORTS = BASE_VIEWPORTS.flatMap((vp) =>
  (['portrait', 'landscape'] as Orientation[]).map((orientation) => ({
    name: `${vp.name}-${orientation}`,
    width: orientation === 'portrait' ? vp.width : vp.height,
    height: orientation === 'portrait' ? vp.height : vp.width,
  })),
);

for (const vp of MOBILE_VIEWPORTS) {
  test(`landlord sheet stacks above find-house dialog — ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/__e2e/landlord-sheet-stacking');

    // The bottom sheet (Radix dialog role) carries the landlord title.
    const sheet = page.getByRole('dialog').filter({ hasText: 'Jane Landlord' });
    await expect(sheet).toBeVisible();
    // Sheet content (full-screen on mobile) must be on top — its title visible.
    await expect(sheet.getByText('Jane Landlord')).toBeVisible();
    await expect(sheet.getByText('UGX 300,000')).toBeVisible();
    // The "Close profile" affordance only renders in the full-screen mobile
    // branch (viewport width < 768px). Wider landscape viewports fall back to
    // the side-sheet, but the sheet must still stack above the dialog.
    const MOBILE_BREAKPOINT = 768;
    if (vp.width < MOBILE_BREAKPOINT) {
      await expect(
        sheet.getByRole('button', { name: /close profile/i }),
      ).toBeVisible();
    }

    // Settle animations before snapshotting.
    await page.waitForTimeout(400);

    await expect(page).toHaveScreenshot(`landlord-sheet-over-dialog-${vp.name}.png`, {
      animations: 'disabled',
      maxDiffPixelRatio: 0.01,
    });
  });
}