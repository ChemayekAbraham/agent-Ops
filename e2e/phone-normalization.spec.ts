import { test, expect } from '@playwright/test';

/**
 * Verifies that a variety of *valid* Ugandan phone input formats — spacing,
 * leading zeros, hyphens, parentheses/dots, a leading '+', the bare country
 * code, and a missing '+256' altogether — are all normalised to the SAME E.164
 * number and produce the correct Call (`tel:+256…`) and WhatsApp
 * (`https://wa.me/256…`) links.
 *
 * Drives the dev-only harness at /__e2e/phone-contact-actions which renders the
 * real `PhoneContactActions` component for the `NORMALIZATION_CASES` matrix.
 */

const HARNESS = '/__e2e/phone-contact-actions';

// Mirrors NORMALIZATION_CASES in PhoneContactActionsHarness.tsx — every input
// format below must normalise to the SAME canonical E.164 number.
const CANONICAL_E164 = '256759229748';

const CASES = [
  { id: 'norm-local', label: 'Local 0-prefix' },
  { id: 'norm-local-spaces', label: 'Local with spaces' },
  { id: 'norm-local-hyphens', label: 'Local with hyphens' },
  { id: 'norm-bare-9', label: 'Bare 9-digit (no 0)' },
  { id: 'norm-intl-no-plus', label: 'Country code no +' },
  { id: 'norm-intl-plus', label: 'Country code with +' },
  { id: 'norm-intl-spaces', label: '+256 with spaces' },
  { id: 'norm-intl-parens', label: '+256 with parens/dots' },
];

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await expect(page.getByTestId('e2e-phone-contact-actions-harness')).toBeVisible();
});

for (const c of CASES) {
  test(`normalises "${c.label}" to tel:+${CANONICAL_E164} and wa.me/${CANONICAL_E164}`, async ({ page }) => {
    const card = page.getByTestId(`case-${c.id}`);

    const call = card.getByRole('link', { name: /^Call/ });
    const whatsapp = card.getByRole('link', { name: /^WhatsApp/ });

    await expect(call).toBeVisible();
    await expect(whatsapp).toBeVisible();

    // Every accepted format collapses to the identical canonical links.
    await expect(call).toHaveAttribute('href', `tel:+${CANONICAL_E164}`);
    await expect(whatsapp).toHaveAttribute('href', `https://wa.me/${CANONICAL_E164}`);
    await expect(whatsapp).toHaveAttribute('target', '_blank');

    // A correctly normalised number never shows the "valid number" hint.
    await expect(card.getByText(/valid number/i)).toHaveCount(0);
  });
}

test('all valid formats produce identical Call + WhatsApp links', async ({ page }) => {
  const telHrefs = new Set<string>();
  const waHrefs = new Set<string>();

  for (const c of CASES) {
    const card = page.getByTestId(`case-${c.id}`);
    telHrefs.add((await card.getByRole('link', { name: /^Call/ }).getAttribute('href')) ?? '');
    waHrefs.add((await card.getByRole('link', { name: /^WhatsApp/ }).getAttribute('href')) ?? '');
  }

  // Despite differing input shapes, there is exactly one resulting link each.
  expect([...telHrefs]).toEqual([`tel:+${CANONICAL_E164}`]);
  expect([...waHrefs]).toEqual([`https://wa.me/${CANONICAL_E164}`]);
});
