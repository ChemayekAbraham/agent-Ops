import { test, expect } from '@playwright/test';

/**
 * Confirms that Call and WhatsApp quick actions stay DISABLED (render no
 * actionable links) for invalid Ugandan phone inputs — wrong length,
 * non-digits, letters, symbols, and unsupported prefixes — and that the
 * disabled-state hint is shown instead.
 *
 * Drives the dev-only harness at /__e2e/phone-contact-actions which renders the
 * real `PhoneContactActions` component for the `INVALID_CASES` matrix.
 */

const HARNESS = '/__e2e/phone-contact-actions';

// Mirrors INVALID_CASES in PhoneContactActionsHarness.tsx.
const CASES = [
  { id: 'inv-too-short', label: 'Too short (8 digits)' },
  { id: 'inv-too-long', label: 'Too long (12 digits)' },
  { id: 'inv-bare-short', label: 'Bare too short' },
  { id: 'inv-bare-long', label: 'Bare too long' },
  { id: 'inv-letters', label: 'Letters only' },
  { id: 'inv-mixed-letters', label: 'Mixed digits + letters' },
  { id: 'inv-symbols', label: 'Symbols only' },
  { id: 'inv-second-digit-low', label: 'Unsupported 2nd digit (<3)' },
  { id: 'inv-second-digit-zero', label: 'Unsupported 2nd digit (0)' },
  { id: 'inv-wrong-country', label: 'Wrong country code (+254)' },
  { id: 'inv-only-country', label: 'Country code only' },
  { id: 'inv-leading-plus', label: 'Just a plus' },
  { id: 'inv-whitespace', label: 'Whitespace only' },
  { id: 'inv-empty', label: 'Empty string' },
  { id: 'inv-null', label: 'Null' },
  { id: 'inv-undefined', label: 'Undefined' },
];

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('e2e-phone-contact-actions-harness')).toBeVisible();
});

for (const c of CASES) {
  test(`keeps Call + WhatsApp disabled for invalid input: ${c.label}`, async ({ page }) => {
    const card = page.getByTestId(`case-${c.id}`);
    await expect(card).toBeVisible();

    // No actionable links of any kind are rendered.
    await expect(card.getByRole('link')).toHaveCount(0);
    await expect(card.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(card.locator('a[href^="https://wa.me/"]')).toHaveCount(0);

    // The disabled-state hint is shown instead ("required" for empty/null/
    // whitespace, "valid Ugandan phone number" for malformed input).
    await expect(card.getByText(/required|valid Ugandan/i)).toBeVisible();
  });
}

test('no invalid input ever exposes a dialable link across the whole matrix', async ({ page }) => {
  for (const c of CASES) {
    const card = page.getByTestId(`case-${c.id}`);
    expect(await card.locator('a[href^="tel:"]').count()).toBe(0);
    expect(await card.locator('a[href^="https://wa.me/"]').count()).toBe(0);
  }
});
