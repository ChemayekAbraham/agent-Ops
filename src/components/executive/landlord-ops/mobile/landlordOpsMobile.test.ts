import { describe, expect, it } from 'vitest';
import { formatOpsUgx, stampLandlordOpsTables } from './landlordOpsPhone';

describe('formatOpsUgx', () => {
  it('prints UGX with thousands separators', () => {
    expect(formatOpsUgx(1234567)).toBe('UGX 1,234,567');
    expect(formatOpsUgx(0)).toBe('UGX 0');
    expect(formatOpsUgx(-2500)).toBe('UGX -2,500');
    expect(formatOpsUgx(Number.NaN)).toBe('UGX 0');
  });
});

describe('stampLandlordOpsTables', () => {
  it('copies header text onto body cells and marks the table for phone cards', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <table>
        <thead><tr><th>Landlord</th><th>Amount</th></tr></thead>
        <tbody>
          <tr><td>Amina</td><td>10</td></tr>
          <tr><td colspan="2">None</td></tr>
        </tbody>
      </table>`;
    stampLandlordOpsTables(root);
    const cells = root.querySelectorAll('td');
    expect(root.querySelector('table')?.classList.contains('lo-card-table')).toBe(true);
    expect(cells[0].getAttribute('data-label')).toBe('Landlord');
    expect(cells[1].getAttribute('data-label')).toBe('Amount');
    expect(cells[2].getAttribute('data-label')).toBe('');
  });
});

describe('the mobile dialog fix for Android (regression guard)', () => {
  it('keeps the Android-specific override that stops a Landlord Ops dialog opening off-screen', async () => {
    // On an Android phone, index.css's generic
    // `html.android-compositor-safe [role="dialog"].app-dialog-content` rule
    // re-centres a normal dialog with `transform: translate3d(-50%, -50%, 0)`.
    // That selector is more specific than the plain `html[data-landlord-ops]
    // .app-dialog-content` rule below it in this file, so without the rule
    // this test checks for, the Landlord Ops full-screen dialog is sized to
    // fill the screen and then shifted left/up by half its own width and
    // height — leaving only its bottom-right corner on screen and the rest
    // (title, most fields, the action buttons) pushed off-screen. Proven live
    // in a browser: the dialog landed at x=-203.5, y=-422 on a 375x812 phone
    // without this rule, and at x=0, y=0 with it.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const css = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/executive/landlord-ops/mobile/landlordOpsMobile.css'),
      'utf8',
    );
    expect(css).toMatch(
      /html\.android-compositor-safe\[data-landlord-ops\]\s+\[role=['"]dialog['"]\]\.app-dialog-content\s*\{[^}]*transform:\s*none\s*!important/,
    );
  });
});
