import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The boardroom's PIPELINE and OPS MAP screens at 1920×1080: light by
 * default, ?theme=dark for the old look (dev-only harness /__e2e/board-screens
 * with the live data shapes). Screenshots go to e2e/board-light.screenshots/.
 *
 *   npx playwright test e2e/board-light.spec.ts
 */

const SHOTS = join(process.cwd(), 'e2e', 'board-light.screenshots');
mkdirSync(SHOTS, { recursive: true });

for (const screen of ['pipeline', 'map'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    test(`${screen} screen, ${theme}, 1920×1080`, async ({ page }) => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(`/__e2e/board-screens?screen=${screen}${theme === 'dark' ? '&theme=dark' : ''}`);
      const main = page.locator('main.ops-board');
      await expect(main).toHaveAttribute('data-ops-theme', theme, { timeout: 60_000 }); // the first visit waits on Vite's cold compile
      // App.tsx remounts the route tree about 1 s after first paint; let fonts and the remount settle.
      await page.waitForTimeout(2500);
      const bg = await main.evaluate((el) => getComputedStyle(el).backgroundColor);
      const ink = await main.evaluate((el) => getComputedStyle(el).color);
      if (theme === 'light') {
        expect(bg).toBe('rgb(246, 245, 251)'); // #F6F5FB
        expect(ink).toBe('rgb(27, 26, 46)'); // #1B1A2E
        const panel = await page.locator(screen === 'map' ? '.ops-rail' : '.ops-stage').first().evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(panel).toBe('rgb(255, 255, 255)');
        const big = await page.locator('.ops-stage-value').first().evaluate((el) => getComputedStyle(el).color);
        expect(big).toBe('rgb(27, 26, 46)');
      } else {
        expect(bg).toBe('rgb(5, 8, 12)'); // the old #05080C
      }
      await page.screenshot({ path: join(SHOTS, `${screen}-${theme}-1920.png`) });
    });
  }
}
