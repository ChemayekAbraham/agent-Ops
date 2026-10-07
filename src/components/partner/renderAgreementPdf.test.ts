import { describe, expect, it } from 'vitest';
import { scopeStylesToRoot } from './renderAgreementPdf';
import { PARTNER_STATEMENT_CSS } from '@/lib/partnerStatementStyles';

describe('scopeStylesToRoot', () => {
  const out = scopeStylesToRoot(`<style>${PARTNER_STATEMENT_CSS}</style>`);

  it('leaves no page-wide selectors that could restyle the app', () => {
    expect(out).not.toMatch(/(^|[}\s,])html\b/);
    expect(out).not.toMatch(/(^|[}\s,])body\b/);
    expect(out).not.toMatch(/:root\s*\{/);
    // no bare universal reset: every `*` rule must sit under the print root
    expect(out).not.toMatch(/^\s*\*\s*,/m);
  });

  it('drops media queries so a phone viewport cannot trigger responsive rules', () => {
    expect(out).not.toContain('@media');
  });

  it('keeps the report rules and variables on the print root', () => {
    expect(out).toContain('.agreement-print-root {');
    expect(out).toContain('--primary-accent');
    expect(out).toContain('.bank-statement-header');
    expect(out).toContain('.portfolio-statement-entry');
  });
});
