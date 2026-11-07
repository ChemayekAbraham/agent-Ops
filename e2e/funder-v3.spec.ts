import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Funder V3 layout checks on the dev-only fixture harness (/__e2e/funder-v3):
 * no auth, no network, a fake map. Screenshots go to e2e/funder-v3.screenshots/.
 *
 *   npx playwright test e2e/funder-v3.spec.ts
 */

const HARNESS = '/__e2e/funder-v3';
const SHOTS = join(process.cwd(), 'e2e', 'funder-v3.screenshots');
mkdirSync(SHOTS, { recursive: true });

const VIEWPORTS: Array<[number, number]> = [
  [360, 800],
  [390, 844],
  [412, 915],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [844, 390],
];

async function open(page: Page, query: string) {
  await page.goto(`${HARNESS}?${query}`);
  await page.waitForSelector('[data-testid="fv3-harness"]', { timeout: 120_000 });
  await settle(page);
}

/**
 * App.tsx's DeferredProviders remounts the whole route tree once its idle-time
 * providers load (about a second after first paint), which wipes page state.
 * Wait for that remount (a fresh harness node) so interactions are not lost.
 * Reported in the V3 PR; not changed here.
 */
async function settle(page: Page) {
  await page.evaluate(async () => {
    const first = document.querySelector('[data-testid="fv3-harness"]') as (Element & { __fv3Seen?: boolean }) | null;
    if (first) first.__fv3Seen = true;
    const started = performance.now();
    while (performance.now() - started < 4000) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const current = document.querySelector('[data-testid="fv3-harness"]') as (Element & { __fv3Seen?: boolean }) | null;
      if (current && !current.__fv3Seen) return;
    }
  });
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  expect(overflow.doc, 'document must not scroll sideways').toBeLessThanOrEqual(0);
  expect(overflow.body, 'body must not scroll sideways').toBeLessThanOrEqual(0);
}

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The launcher, when visible, must never sit on any Fund button or the hero CTA. */
async function launcherClearOfCtas(page: Page) {
  const launcher = page.getByTestId('assistant-launcher');
  if ((await launcher.count()) === 0 || !(await launcher.isVisible())) return;
  const lb = await launcher.boundingBox();
  if (!lb) return;
  const ctas = page.locator('[data-testid="fv3-fund-button"]:visible, [data-testid="fv3-hero-cta"]:visible');
  const n = await ctas.count();
  for (let i = 0; i < n; i += 1) {
    const box = await ctas.nth(i).boundingBox();
    if (box) expect(overlaps(lb, box), `launcher overlaps CTA #${i}`).toBe(false);
  }
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

for (const [width, height] of VIEWPORTS) {
  test(`${width}x${height}: home and houses lay out without sideways scroll`, async ({ page }) => {
    await page.setViewportSize({ width, height });

    await open(page, 'view=home');
    await expect(page.getByTestId('fv3-home')).toBeVisible();
    await noHorizontalScroll(page);
    await launcherClearOfCtas(page);
    await page.screenshot({ path: join(SHOTS, `home-${width}x${height}.png`) });

    await open(page, 'view=houses&count=24');
    const screen = page.getByTestId('fv3-houses');
    await expect(screen).toBeVisible();
    await expect(page.getByTestId('fv3-card').first()).toBeVisible();
    await expect(page.getByTestId('fv3-count')).toHaveText('24 of 2,534');
    await noHorizontalScroll(page);
    // The houses screen owns the page: the launcher is hidden, so it can cover no Fund button.
    await expect(page.getByTestId('assistant-launcher')).toHaveCount(0);
    await launcherClearOfCtas(page);
    const expected = width >= 1024 ? 'expanded' : width >= 640 ? 'medium' : 'compact';
    await expect(screen).toHaveAttribute('data-layout', expected);
    await page.screenshot({ path: join(SHOTS, `houses-${width}x${height}.png`) });
  });
}

test('≥1024: the list pane scrolls with the mouse wheel', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'view=houses&count=24');
  const pane = page.getByTestId('fv3-pane-scroll');
  await expect(pane).toBeVisible();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 900);
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
});

test('<1024: the list scrolls while the sheet rests at half', async ({ page }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24');
    const sheet = page.getByTestId('fv3-sheet');
    await expect(sheet).toHaveAttribute('data-snap', 'half');
    const content = page.getByTestId('fv3-sheet-content');
    const box = (await content.boundingBox())!;
    // Wheel over the visible part of the sheet (its lower part is below the screen).
    const y = Math.min(box.y + 120, size.height - 80);
    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.wheel(0, 700);
    await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBeGreaterThan(150);
  }
});

test('<1024: Map/List toggle and handle move the sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  const sheet = page.getByTestId('fv3-sheet');
  await page.getByTestId('fv3-toggle').click();
  await expect(sheet).toHaveAttribute('data-snap', 'full');
  await expect(page.getByTestId('fv3-toggle')).toHaveText(/Map/);
  await page.getByTestId('fv3-toggle').click();
  await expect(sheet).toHaveAttribute('data-snap', 'peek');
});

test('≥1024: a pin scrolls to its card and highlights it; hovering a card lights its pin', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, 'view=houses&count=24');
  const pin = page.locator('[data-testid="fv3-fake-pin"][data-house-id="house-15"]');
  await pin.click();
  const card = page.locator('[data-card-id="empty:house-15"]');
  await expect(card).toHaveAttribute('data-highlighted', 'true');
  await expect(card).toBeInViewport();

  const other = page.locator('[data-card-id="empty:house-2"]');
  await other.scrollIntoViewIfNeeded();
  await other.hover();
  await expect(page.locator('[data-testid="fv3-fake-pin"][data-house-id="house-2"]')).toHaveAttribute('data-active', 'true');
});

test('<1024: a pin opens the house (live behaviour)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  await page.getByTestId('fv3-toggle').click(); // full
  await page.getByTestId('fv3-toggle').click(); // peek: pins clear of the sheet
  await page.locator('[data-testid="fv3-fake-pin"]').first().click();
  await expect(page.getByTestId('fv3-harness-detail')).toBeVisible();
});

test('live resize 1280 → 390 → 1280 keeps the right layout and scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'view=houses&count=24');
  const screen = page.getByTestId('fv3-houses');
  await expect(screen).toHaveAttribute('data-layout', 'expanded');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(screen).toHaveAttribute('data-layout', 'compact');
  await expect(page.getByTestId('fv3-sheet')).toBeVisible();
  await expect(page.getByTestId('fv3-count')).toHaveText('24 of 2,534');
  await noHorizontalScroll(page);

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(screen).toHaveAttribute('data-layout', 'expanded');
  const pane = page.getByTestId('fv3-pane-scroll');
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 600);
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
  await noHorizontalScroll(page);
});

test('"Show more" keeps paging; count reads "N of total"', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'view=houses&count=12');
  await expect(page.getByTestId('fv3-count')).toHaveText('12 of 2,534');
  const more = page.getByTestId('fv3-show-more');
  await more.scrollIntoViewIfNeeded();
  await expect(more).toHaveText('Show more homes (2,522 left)');
  await more.click();
  await expect(page.getByTestId('fv3-count')).toHaveText('24 of 2,534');
});

test('past 60 cards the list is windowed', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'view=houses&count=120');
  await expect(page.getByTestId('fv3-count')).toHaveText('120 of 2,534');
  const rendered = await page.getByTestId('fv3-card').count();
  expect(rendered).toBeGreaterThan(0);
  expect(rendered).toBeLessThan(40);
  // A pin for a card far down still scrolls to it.
  await page.locator('[data-testid="fv3-fake-pin"][data-house-id="house-30"]').click();
  await expect(page.locator('[data-card-id="empty:house-30"]')).toBeInViewport();
});

test('dark theme renders through the same tokens', async ({ page }) => {
  for (const [width, height] of [[390, 844], [1280, 800]] as const) {
    await page.setViewportSize({ width, height });
    await open(page, 'view=houses&count=24');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    await expect(page.getByTestId('fv3-card').first()).toBeVisible();
    const bg = await page.getByTestId('fv3-houses').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe('rgb(255, 255, 255)');
    await page.screenshot({ path: join(SHOTS, `houses-dark-${width}x${height}.png`) });
  }
});

test('first card photo is eager + high priority, the rest lazy, all sized', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=12');
  const imgs = page.locator('[data-testid="fv3-card"] img');
  await expect(imgs.first()).toHaveAttribute('loading', 'eager');
  await expect(imgs.first()).toHaveAttribute('fetchpriority', 'high');
  await expect(imgs.nth(1)).toHaveAttribute('loading', 'lazy');
  for (const attr of ['width', 'height', 'sizes', 'decoding']) await expect(imgs.nth(1)).toHaveAttribute(attr, /.+/);
});
