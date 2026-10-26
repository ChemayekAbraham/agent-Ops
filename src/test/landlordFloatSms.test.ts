import { describe, expect, it } from 'vitest';
import {
  buildLandlordMessage,
  maskPhone,
  tenantPhrase,
} from '../../supabase/functions/_shared/landlordFloatSms';

const BANNED = /\b(loan|lender|interest|roi|investor|invest|supporter|partner)\b/i;

describe('landlord float SMS', () => {
  it('names one tenant and the agent, and masks the payout number', () => {
    const m = buildLandlordMessage({
      amount: 600000,
      tenant_count: 1,
      tenant_first_names: ['Sarah'],
      agent_name: 'Moses Okello',
      landlord_phone: '+256 742 799 042',
    });
    expect(m).toBe(
      'WELILE: UGX 600,000 rent for Sarah is approved. Agent Moses will pay you on 0742***042. Keep your phone on.',
    );
    expect(m).not.toContain('799');
  });

  it('handles two, several and unnamed tenants', () => {
    expect(tenantPhrase(['Sarah', 'John'], 2)).toBe('Sarah and John');
    expect(tenantPhrase(['Sarah', 'John', 'Mary'], 3)).toBe('Sarah, John and 1 more tenant');
    expect(tenantPhrase(['Sarah', 'John', 'Mary', 'Paul'], 4)).toBe('Sarah, John and 2 more tenants');
    expect(tenantPhrase([], 3)).toBe('3 tenants');
    expect(tenantPhrase(null, 1)).toBe('1 tenant');
  });

  it('uses only first names, capped in length', () => {
    expect(tenantPhrase(['Kamugisha Ronald Bright'], 1)).toBe('Kamugisha');
    expect(tenantPhrase(['Nakitandwewamukasa'], 1).length).toBeLessThanOrEqual(14);
  });

  it('falls back when the agent or the phone is missing', () => {
    const m = buildLandlordMessage({ amount: 450000, tenant_count: 1, tenant_first_names: ['Ann'] });
    expect(m).toContain('Your agent will pay you on your registered number.');
  });

  it('never names the funding partner and avoids regulated wording', () => {
    const m = buildLandlordMessage({
      amount: 1250000,
      tenant_count: 3,
      tenant_first_names: ['Sarah', 'John', 'Mary'],
      agent_name: 'Moses',
      landlord_phone: '0742799042',
    });
    expect(m).not.toMatch(BANNED);
  });

  it('stays short enough for one segment with the platform footer', () => {
    const m = buildLandlordMessage({
      amount: 12345678,
      tenant_count: 5,
      tenant_first_names: ['Nakitandwewamukasa', 'Kamugishaaaaaaaaa', 'Mary', 'Paul', 'Ann'],
      agent_name: 'Bartholomew Okello',
      landlord_phone: '0742799042',
    });
    // body + "\nHelp: 0748747134" must fit 160 characters
    expect(m.length + '\nHelp: 0748747134'.length).toBeLessThanOrEqual(160);
  });

  it('masks numbers consistently', () => {
    expect(maskPhone('0742799042')).toBe('0742***042');
    expect(maskPhone('256742799042')).toBe('0742***042');
    expect(maskPhone('')).toBe('');
    expect(maskPhone('12')).toBe('');
  });
});
