import { test, expect } from '@playwright/test';

/**
 * The Send Money item picker must be usable with a mouse on desktop: the
 * Previous/Next arrows, the Close button and "Choose this" all have to sit
 * inside the (narrow, centred) dialog, not out at the browser window's edges.
 */
const VIEWPORTS = [
  { name: 'desktop-1280x720', width: 1280, height: 720 },
  { name: 'laptop-1366x768', width: 1366, height: 768 },
  { name: 'wide-1920x1080', width: 1920, height: 1080 },
  { name: 'phone-390x844', width: 390, height: 844 },
];

for (const vp of VIEWPORTS) {
  test(`item picker is operable by mouse at ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/__e2e/item-swipe-picker');
    await page.getByTestId('open-picker').click();

    const picker = page.locator('[data-item-picker]');
    await expect(picker).toBeVisible();

    const host = page.locator('[role="dialog"]').first();
    const hostBox = (await host.boundingBox())!;

    const inside = async (name: string | RegExp) => {
      const box = await page.getByRole('button', { name }).first().boundingBox();
      expect(box, `${String(name)} has a box`).not.toBeNull();
      expect(box!.x, `${String(name)} left edge`).toBeGreaterThanOrEqual(hostBox.x - 1);
      expect(box!.y, `${String(name)} top edge`).toBeGreaterThanOrEqual(hostBox.y - 1);
      expect(box!.x + box!.width, `${String(name)} right edge`).toBeLessThanOrEqual(hostBox.x + hostBox.width + 1);
      expect(box!.y + box!.height, `${String(name)} bottom edge`).toBeLessThanOrEqual(hostBox.y + hostBox.height + 1);
    };

    await inside(/close item picker/i);
    await inside(/^next item/i);
    await inside(/^choose /i);

    // Mouse only: step to the second item and pick it.
    await page.getByRole('button', { name: /^next item/i }).click();
    await expect(page.getByRole('button', { name: 'Choose Welile Gift' })).toBeEnabled();
    await page.getByRole('button', { name: 'Choose Welile Gift' }).click();
    await expect(page.getByTestId('picked')).toHaveText('Welile Gift');
  });
}
