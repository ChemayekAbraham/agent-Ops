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

/** Share of the screen height the map window shows right now. */
async function mapShare(page: Page): Promise<number> {
  return page.getByTestId('fv3-map-window').evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const visible = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0);
    return visible / window.innerHeight;
  });
}

for (const size of [{ width: 360, height: 800 }, { width: 390, height: 844 }]) {
  test(`${size.width}x${size.height}: map is half the screen, shrinks to a quarter as the list scrolls, and grows back`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24');
    const scroller = page.getByTestId('fv3-scroll');
    await expect(page.getByTestId('fv3-map-window')).toBeVisible();
    expect(await mapShare(page)).toBeGreaterThan(0.47);
    expect(await mapShare(page)).toBeLessThan(0.53);

    // Scroll the list 300px with the wheel, over the list.
    await page.mouse.move(size.width / 2, size.height * 0.8);
    await page.mouse.wheel(0, 300);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(290);
    await expect.poll(() => mapShare(page)).toBeLessThan(0.27);
    expect(await mapShare(page)).toBeGreaterThan(0.23);
    // The houses keep scrolling under the pinned map: never stuck.
    await page.mouse.wheel(0, 900);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
    expect(await mapShare(page)).toBeGreaterThan(0.23);
    await page.screenshot({ path: join(SHOTS, `houses-scrolled-${size.width}x${size.height}.png`) });

    // Back to the top: the map grows back to half.
    await page.mouse.wheel(0, -5000);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(0);
    await expect.poll(() => mapShare(page)).toBeGreaterThan(0.47);

    // The wheel over the map itself scrolls the list too (one scroll).
    await page.mouse.move(size.width / 2, size.height * 0.3);
    await page.mouse.wheel(0, 250);
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  });
}

test('<1024: the shrinking map also works with the Android compositor rules on', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  // main.tsx sets this class on Android and low-end phones; its rules strip transforms and sticky inside dialogs.
  await page.evaluate(() => document.documentElement.classList.add('android-compositor-safe'));
  const scroller = page.getByTestId('fv3-scroll');
  await page.mouse.move(195, 700);
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(390);
  await expect.poll(() => mapShare(page)).toBeLessThan(0.27);
  expect(await mapShare(page)).toBeGreaterThan(0.23);
});

test('<1024: back returns to the funder home', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  await page.mouse.move(195, 700);
  await page.mouse.wheel(0, 800);
  await page.getByTestId('fv3-back').click();
  await expect(page.getByTestId('fv3-houses')).toHaveCount(0);
  await expect(page.getByTestId('fv3-home')).toBeVisible();

  // The phone's back gesture does the same.
  await page.getByTestId('fv3-hero-cta').click();
  await expect(page.getByTestId('fv3-houses')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('fv3-houses')).toHaveCount(0);
  await expect(page.getByTestId('fv3-home')).toBeVisible();
});

test('<1024: tapping the map or its expand button opens it full screen; close returns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  const screen = page.getByTestId('fv3-houses');
  await page.getByTestId('fv3-map-fullscreen').click();
  await expect(screen).toHaveAttribute('data-map-full', 'true');
  await expect.poll(() => mapShare(page)).toBeGreaterThan(0.97);
  await expect(page.getByTestId('fv3-fake-map')).toHaveAttribute('data-interactive', 'true');
  await page.getByTestId('fv3-map-fullscreen').click();
  await expect(screen).not.toHaveAttribute('data-map-full', 'true');
  await expect.poll(() => mapShare(page)).toBeLessThan(0.53);

  // A tap on the still map (not a pin) also opens it.
  await page.getByTestId('fv3-fake-map').dispatchEvent('click');
  await expect(screen).toHaveAttribute('data-map-full', 'true');
  await page.keyboard.press('Escape');
  await expect(screen).not.toHaveAttribute('data-map-full', 'true');
  await expect(screen).toBeVisible();
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

test('<1024: a pin scrolls the list to its house and highlights it, clear of the map', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  await page.locator('[data-testid="fv3-fake-pin"][data-house-id="house-15"]').click();
  const card = page.locator('[data-card-id="empty:house-15"]');
  await expect(card).toHaveAttribute('data-highlighted', 'true');
  await expect(card).toBeInViewport();
  await expect(page.getByTestId('fv3-harness-detail')).toHaveCount(0);
  // Once settled the card's top is below the pinned map.
  await expect
    .poll(async () => {
      const cardTop = (await card.boundingBox())!.y;
      const mapBottom = await page.getByTestId('fv3-map-window').evaluate((el) => el.getBoundingClientRect().bottom);
      return cardTop - mapBottom;
    })
    .toBeGreaterThan(-1);
});

test('live resize 1280 → 390 → 1280 keeps the right layout and scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'view=houses&count=24');
  const screen = page.getByTestId('fv3-houses');
  await expect(screen).toHaveAttribute('data-layout', 'expanded');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(screen).toHaveAttribute('data-layout', 'compact');
  await expect(page.getByTestId('fv3-map-window')).toBeVisible();
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

// ---- E59: funders board tags and demote ----

test('E59: a normal funder sees no demote controls', async ({ page }) => {
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24');
    await expect(page.getByTestId('fv3-card').first()).toBeVisible();
    await expect(page.getByTestId('fv3-demote-toggle')).toHaveCount(0);
    await expect(page.getByTestId('fv3-demote-check')).toHaveCount(0);
    await expect(page.getByTestId('fv3-demote-bar')).toHaveCount(0);
  }
});

test('E59: the COO sees the toggle, ticks houses and demotes with a reason', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, 'view=houses&count=24&demote=1');
  await expect(page.getByTestId('fv3-demote-toggle')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24&demote=1');
  const toggle = page.getByTestId('fv3-demote-toggle');
  await expect(toggle).toHaveText(/Select to demote/);
  await expect(page.getByTestId('fv3-demote-check')).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const checks = page.getByTestId('fv3-demote-check');
  await expect(checks.first()).toBeVisible();

  // The bar sits in the page, not in a dialog (Android strips sticky/transform inside dialogs).
  const bar = page.getByTestId('fv3-demote-bar');
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => !!el.closest('[role="dialog"]'))).toBe(false);
  await expect(page.getByTestId('fv3-demote-open')).toBeDisabled();

  await checks.nth(0).locator('input').check();
  await checks.nth(1).scrollIntoViewIfNeeded();
  await checks.nth(1).locator('input').check();
  await expect(page.getByTestId('fv3-demote-open')).toHaveText('Demote 2');
  await page.getByTestId('fv3-demote-open').click();

  const sheet = page.getByTestId('fv3-demote-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[data-reason="FB_NOT_QUALIFIED"]')).toHaveAttribute('aria-checked', 'true');
  const confirm = page.getByTestId('fv3-demote-confirm');
  await expect(confirm).toBeEnabled();
  // "Other" needs a 10+ character note.
  await sheet.locator('[data-reason="OTHER"]').click();
  await expect(confirm).toBeDisabled();
  await page.getByTestId('fv3-demote-note').fill('too short');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('fv3-demote-note').fill('Tenant moved out last week');
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByText('1 demoted · 1 skipped')).toBeVisible();
  await expect(page.getByText('Already funded, left on the board')).toBeVisible();
  await expect(sheet).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('fv3-demote-check')).toHaveCount(0);
});

test('E59: tags are hidden when the switch is off and there is no preview row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  await expect(page.getByTestId('fv3-card').first()).toBeVisible();
  await expect(page.getByTestId('funders-board-tag')).toHaveCount(0);
  await expect(page.locator('[data-testid="fv3-fake-pin"]').first()).toHaveAttribute('data-tone', 'plain');
  await page.goto(`${HARNESS}?ui=old&count=12`);
  await page.waitForSelector('[data-testid="fv3-harness-old"]', { timeout: 120_000 });
  await expect(page.getByTestId('funders-board-tag')).toHaveCount(0);
});

test('E59: with the switch on, every card is tagged and pins take the tag colour', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24&tags=on');
  const verified = page.locator('[data-card-id^="ready:"] [data-testid="funders-board-tag"]').first();
  await expect(verified).toHaveText('Verified');
  await expect(verified).toHaveAttribute('data-tag', 'verified');
  const empty = page.locator('[data-card-id^="empty:"] [data-testid="funders-board-tag"]').first();
  await empty.scrollIntoViewIfNeeded();
  await expect(empty).toHaveText('Empty house');
  await expect(page.locator('[data-testid="fv3-fake-pin"]').first()).toHaveAttribute('data-tone', 'empty');
  await page.screenshot({ path: join(SHOTS, 'houses-tags-390x844.png') });
  // Legacy cards too.
  await page.goto(`${HARNESS}?ui=old&count=12&tags=on`);
  await page.waitForSelector('[data-testid="fv3-harness-old"]', { timeout: 120_000 });
  await expect(page.getByTestId('funders-board-tag')).toHaveCount(12);
});


// ---- No distance limit by default; distances on cards (both with the switch off) ----

for (const size of [{ width: 360, height: 800 }, { width: 412, height: 915 }]) {
  test(`${size.width}x${size.height}: no distance limit by default and distance on cards`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24');
    await expect(page.getByTestId('fv3-count')).toHaveText('24 of 2,534');
    await expect(page.getByTestId('fv3-radius-note')).toHaveCount(0);
    await expect(page.getByText(/Within \d+ km/)).toHaveCount(0);
    const distances = page.locator('[data-testid="fv3-card"]').getByText(/^About [\d.,]+ (km|m) away/);
    await expect(distances.first()).toBeVisible();
    expect(await distances.count()).toBeGreaterThan(3);
    await noHorizontalScroll(page);
  });
}

// ---- E72b grouped list (funders_board_tags on) ----

const GROUP_ORDER = ['verified', 'booked', 'funded', 'pending_verification', 'empty_house'];

for (const size of [{ width: 360, height: 800 }, { width: 412, height: 915 }]) {
  test(`${size.width}x${size.height}: groups in order, header totals, view-only cards, one chip per card`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24&tags=board');
    const groups = await page.locator('[data-board-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-board-group')));
    expect(groups).toEqual(GROUP_ORDER);
    await expect(page.getByTestId('fv3-count')).toHaveText('5 ready to fund · UGX 1,950,000');
    await expect(page.getByTestId('fv3-count-sub')).toHaveText('3 verified · 2 pending verification');
    // Every card in a group carries that group's tag only (never mixed), and exactly one chip.
    for (const tag of GROUP_ORDER) {
      const chips = await page.locator(`[data-board-group="${tag}"] [data-testid="funders-board-tag"]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-tag')));
      expect(chips.length).toBeGreaterThan(0);
      expect(new Set(chips)).toEqual(new Set([tag === 'empty_house' ? 'empty' : tag]));
    }
    const perCard = await page.locator('[data-board-group] article').evaluateAll((els) => els.map((e) => e.querySelectorAll('[data-testid="funders-board-tag"]').length));
    expect(perCard.every((n) => n === 1)).toBe(true);
    await expect(page.getByText('Verified tenant')).toHaveCount(0);
    // Booked, Funded, Pending verification (and a held Verified) are view only: no fund button.
    for (const tag of ['booked', 'funded', 'pending_verification']) {
      await expect(page.locator(`[data-board-group="${tag}"] [data-testid="fv3-fund-button"]`)).toHaveCount(0);
    }
    await expect(page.locator('[data-board-group="verified"] [data-testid="fv3-fund-button"]').first()).toBeVisible();
    await expect(page.locator('article[data-card-id="board:rq-held"] [data-testid="fv3-fund-button"]')).toHaveCount(0);
    await noHorizontalScroll(page);
    await page.screenshot({ path: join(SHOTS, `houses-board-${size.width}x${size.height}.png`) });
  });

  test(`${size.width}x${size.height}: pins take their tag colour and a pin scrolls to its card`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24&tags=board');
    const tones = await page.locator('[data-testid="fv3-fake-board-pin"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-tone')));
    expect(new Set(tones)).toEqual(new Set(['verified', 'booked', 'funded', 'pending_verification']));
    await page.locator('[data-testid="fv3-fake-board-pin"][data-card-id="board:rq-f1"]').click();
    const card = page.locator('article[data-card-id="board:rq-f1"]');
    await expect(card).toHaveAttribute('data-highlighted', 'true');
    await expect(card).toBeInViewport();
  });
}

test('E72b: demote stays on Verified and Empty house cards only', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24&tags=board&demote=1');
  await page.getByTestId('fv3-demote-toggle').click();
  await expect(page.locator('[data-board-group="verified"] [data-testid="fv3-demote-check"]').first()).toBeVisible();
  await expect(page.locator('article[data-card-id="board:rq-held"] [data-testid="fv3-demote-check"]')).toHaveCount(1);
  await expect(page.locator('[data-board-group="empty_house"] [data-testid="fv3-demote-check"]').first()).toBeAttached();
  for (const tag of ['booked', 'funded', 'pending_verification']) {
    await expect(page.locator(`[data-board-group="${tag}"] [data-testid="fv3-demote-check"]`)).toHaveCount(0);
  }
});

test("E72b: with the switch off the list is today's (no groups)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'view=houses&count=24');
  await expect(page.locator('[data-board-group]')).toHaveCount(0);
  await expect(page.getByTestId('fv3-count')).toHaveText('24 of 2,534');
});

// ---- Empty houses Welile has not checked (house_listings.verified = false) ----

for (const size of [{ width: 360, height: 800 }, { width: 412, height: 915 }]) {
  test(`${size.width}x${size.height}: unchecked empty houses show a grey line instead of a Fund button`, async ({ page }) => {
    await page.setViewportSize(size);
    await open(page, 'view=houses&count=24&unchecked=1');
    const unchecked = page.locator('[data-testid="fv3-card"]:has([data-testid="fv3-not-checked"])');
    expect(await unchecked.count()).toBeGreaterThan(2);
    for (let i = 0; i < Math.min(3, await unchecked.count()); i += 1) {
      const card = unchecked.nth(i);
      await expect(card.getByTestId('fv3-not-checked')).toHaveText('House not yet checked by Welile');
      await expect(card.getByTestId('fv3-fund-button')).toHaveCount(0);
      await expect(card.getByText(/Details/)).toHaveCount(1);
    }
    // Verified empty houses keep "Fund this House".
    const verifiedEmpty = page.locator('[data-card-id^="empty:"]:not(:has([data-testid="fv3-not-checked"]))');
    await expect(verifiedEmpty.first().getByTestId('fv3-fund-button')).toHaveText(/Fund this House/);
    // "Pending verification" never appears on an empty house.
    await expect(page.locator('[data-card-id^="empty:"]').getByText(/Pending verification/i)).toHaveCount(0);
    await unchecked.first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(SHOTS, `houses-unchecked-${size.width}x${size.height}.png`) });
  });
}
