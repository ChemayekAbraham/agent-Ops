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
