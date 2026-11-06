import { describe, expect, it } from 'vitest';
import {
  WELILE_EMAIL_BRAND_INFO,
  WELILE_EMAIL_BRAND_HEADER_HTML,
  WELILE_EMAIL_BRAND_HEADER_TEXT,
  WELILE_EMAIL_HEADER_MARKER,
  ensureWelileEmailHeader,
  ensureWelileEmailTextHeader,
} from '../lib/emailHeader';

describe('Welile email letterhead', () => {
  it('carries the official brand details', () => {
    expect(WELILE_EMAIL_HEADER_MARKER).toBe('data-welile-email-header="1"');
    expect(WELILE_EMAIL_BRAND_INFO.legalName).toBe('Welile Technologies Limited');
    expect(WELILE_EMAIL_BRAND_INFO.fullPostalAddress).toBe('Palm Lane, Kabaale, Entebbe, Uganda | P.O. Box 1675664');
    expect(WELILE_EMAIL_BRAND_INFO.officialEmail).toBe('info@welile.com');
    expect(WELILE_EMAIL_BRAND_INFO.customerCareNumber).toBe('+256 748 747 134');
    expect(WELILE_EMAIL_BRAND_INFO.logoUrl).toBe('https://welileapp.com/welile-logo.png');
    expect(WELILE_EMAIL_BRAND_HEADER_HTML).toContain(WELILE_EMAIL_HEADER_MARKER);
    expect(WELILE_EMAIL_BRAND_HEADER_HTML).toContain('welileapp.com');
    expect(WELILE_EMAIL_BRAND_HEADER_TEXT).toContain('WELILE TECHNOLOGIES LIMITED');
  });

  it('injects the header right after <body>', () => {
    const out = ensureWelileEmailHeader('<html><body style="margin:0"><p>Hello</p></body></html>');
    const bodyEnd = out.indexOf('>') ;
    expect(out.indexOf(WELILE_EMAIL_HEADER_MARKER)).toBeGreaterThan(-1);
    expect(out.indexOf(WELILE_EMAIL_HEADER_MARKER)).toBeLessThan(out.indexOf('<p>Hello</p>'));
    expect(out.toLowerCase().indexOf('<body')).toBeLessThan(out.indexOf(WELILE_EMAIL_HEADER_MARKER));
    expect(bodyEnd).toBeGreaterThan(-1);
  });

  it('prepends the header when there is no body tag', () => {
    const out = ensureWelileEmailHeader('<p>Fragment</p>');
    expect(out.startsWith(WELILE_EMAIL_BRAND_HEADER_HTML)).toBe(true);
  });

  it('is idempotent for HTML', () => {
    const once = ensureWelileEmailHeader('<body><p>Hi</p></body>');
    const twice = ensureWelileEmailHeader(once);
    expect(twice).toBe(once);
    expect(once.split('data-welile-email-header').length - 1).toBe(1);
  });

  it('prepends the plain-text letterhead idempotently', () => {
    const once = ensureWelileEmailTextHeader('Your code is 123456');
    expect(once.startsWith('WELILE TECHNOLOGIES LIMITED')).toBe(true);
    expect(once).toContain('Your code is 123456');
    expect(ensureWelileEmailTextHeader(once)).toBe(once);
  });

  it('leaves empty input untouched', () => {
    expect(ensureWelileEmailHeader('')).toBe('');
    expect(ensureWelileEmailTextHeader('')).toBe('');
  });
});
