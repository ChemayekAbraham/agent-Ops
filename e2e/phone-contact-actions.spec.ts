import { test, expect } from '@playwright/test';

/**
 * Verifies the rent-request landlord Call / WhatsApp quick actions:
 *   - Invalid / missing phone numbers render NO actionable links (effectively
 *     "disabled") and show the "valid number" hint instead.
 *   - Valid numbers render enabled Call (`tel:+256…`) and WhatsApp
 *     (`https://wa.me/256…`) links with the correctly normalised E.164 number.
 *
 * Drives the dev-only harness at /__e2e/phone-contact-actions which renders the
 * real `PhoneContactActions` component for a battery of inputs.
 */

const HARNESS = '/__e2e/phone-contact-actions';

const VALID = [
  { id: 'valid-local', e164: '256759229748' },
  { id: 'valid-spaced', e164: '256772123456' },
  { id: 'valid-intl', e164: '256759229748' },
  { id: 'valid-bare', e164: '256759229748' },
];

const INVALID = [
  'invalid-short',
  'invalid-long',
  'invalid-prefix',
  'invalid-letters',
  'empty',
  'null',
];

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('e2e-phone-contact-actions-harness')).toBeVisible();
});

for (const c of VALID) {
  test(`enables Call + WhatsApp with correct links for ${c.id}`, async ({ page }) => {
    const card = page.getByTestId(`case-${c.id}`);

    const call = card.getByRole('link', { name: /^Call/ });
    const whatsapp = card.getByRole('link', { name: /^WhatsApp/ });

    await expect(call).toBeVisible();
    await expect(whatsapp).toBeVisible();

    await expect(call).toHaveAttribute('href', `tel:+${c.e164}`);
    await expect(whatsapp).toHaveAttribute('href', `https://wa.me/${c.e164}`);
    await expect(whatsapp).toHaveAttribute('target', '_blank');

    // No "invalid number" hint should appear for valid numbers.
    await expect(card.getByText(/valid number/i)).toHaveCount(0);
  });
}

for (const id of INVALID) {
  test(`keeps Call + WhatsApp disabled (no links) for ${id}`, async ({ page }) => {
    const card = page.getByTestId(`case-${id}`);

    // No actionable tel:/wa.me links are rendered at all.
    await expect(card.getByRole('link')).toHaveCount(0);
    await expect(card.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(card.locator('a[href^="https://wa.me/"]')).toHaveCount(0);

    // The disabled-state hint is shown instead ("required" for empty/null,
    // "valid Ugandan phone number" for malformed input).
    await expect(card.getByText(/required|valid Ugandan/i)).toBeVisible();
  });
}