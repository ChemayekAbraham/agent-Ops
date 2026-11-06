import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { landlordPhoneKey } from '@/lib/welileHomesLandlordVerify';

const lib = readFileSync(path.join(process.cwd(), 'src/lib/welileHomesLandlordVerify.ts'), 'utf8');
const sheet = readFileSync(path.join(process.cwd(), 'src/components/agent/AgentWelileHomesSheet.tsx'), 'utf8');

describe('Welile Homes landlord portfolio verification', () => {
  it('groups a landlord by the same phone key as the server (last 9 digits)', () => {
    expect(landlordPhoneKey('0787154656')).toBe('787154656');
    expect(landlordPhoneKey('+256 787 154 656')).toBe('787154656');
    expect(landlordPhoneKey('0787')).toBeNull();
  });

  it('checks the code on the server, never with the browser verify step', () => {
    expect(lib).toContain("'wh_portfolio_verify_landlord'");
    expect(lib).not.toMatch(/action:\s*'verify'/);
  });

  it('never sends a tenant verification code', () => {
    expect(sheet).not.toContain('welile_homes_tenant_verify');
    expect(sheet).not.toContain('VerifyTenantDialog');
  });
});
