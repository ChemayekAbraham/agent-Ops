import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261113170000_funder_offplatform_cover_fee.sql'),
  'utf8',
);

describe('offplatform Welile Cover ledger category', () => {
  it('posts welile_cover_fee from the withdrawable wallet, not a retired or capital category', () => {
    expect(sql).toContain("'category', 'welile_cover_fee'");
    expect(sql).toContain("'wallet_bucket', 'withdrawable'");
    expect(sql).toContain("ARRAY['welile_cover_fee']");
    expect(sql).toContain("account_code, debit_when, notes)");
    expect(sql).toContain("'L1', 'cash_out'");
    expect(sql).not.toContain("'category', 'wallet_deduction'");
    expect(sql).not.toContain("'category', 'partner_funding'");
    expect(sql).not.toContain("'category', 'supporter_rent_fund'");
  });
});
