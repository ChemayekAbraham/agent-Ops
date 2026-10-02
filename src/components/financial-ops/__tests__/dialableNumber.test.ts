import { describe, expect, it } from 'vitest';
import { dialHref } from '../DialableNumber';

/**
 * The `tel:` target must be identical whichever way the number was stored in
 * the email, and must never be invented for text that holds no number.
 */
describe('dialHref', () => {
  it('builds tel:+256 with the last nine digits for every stored shape', () => {
    const expected = 'tel:+256748787893';
    for (const stored of ['0748787893', '+256748787893', '256748787893', '748787893']) {
      expect(dialHref(stored)).toBe(expected);
    }
  });

  it('keeps spacing, hyphens and brackets dialable', () => {
    expect(dialHref('0748 787 893')).toBe('tel:+256748787893');
    expect(dialHref('+256-748-787893')).toBe('tel:+256748787893');
  });

  it('finds the number inside a sentence the way the snippet shows it', () => {
    expect(
      dialHref('You have received UGX 50,000.00 from 0748787893 at 10:14'),
    ).toBe('tel:+256748787893');
  });

  it('renders no link for a sender that is not a number', () => {
    for (const plain of [
      'Android SMS via IFTTT',
      'MTN Mobile Money',
      'support@welileapp.com',
      'Ref STC-1748787893001',
      '',
      null,
      undefined,
    ]) {
      expect(dialHref(plain)).toBeNull();
    }
  });
});
