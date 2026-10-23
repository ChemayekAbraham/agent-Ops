import { describe, it, expect } from 'vitest';
import { buildPlanShareLink, buildPlanShareMessage, buildWhatsAppShareUrl } from '@/components/funder-new/FunderNewSelectionPanel';

const item = { id: 'abc-123', category: 'ready' as const, tenantName: 'Test Tenant', tenantPhone: '+256700000000', landlordPhone: '0700000001' };

describe('support plan share link', () => {
  it('points to this home on the Partners dashboard route', () => {
    expect(buildPlanShareLink(item, 'https://welileapp.com/')).toBe('https://welileapp.com/dashboard/funder-new?plan=ready%3Aabc-123');
  });
  it('uses the tenant first name and the link', () => {
    const link = buildPlanShareLink(item, 'https://welileapp.com');
    const msg = buildPlanShareMessage(item, link);
    expect(msg.startsWith('Help Test keep their home')).toBe(true);
    expect(msg.endsWith(`See the plan: ${link}`)).toBe(true);
  });
  it('never includes phone numbers', () => {
    const msg = buildPlanShareMessage(item, 'https://welileapp.com/x');
    expect(msg).not.toMatch(/700000000|700000001|\+256/);
  });
  it('falls back when no tenant name', () => {
    expect(buildPlanShareMessage({ tenantName: null }, 'L')).toMatch(/^Help a tenant keep/);
  });
  it('builds a wa.me text url', () => {
    expect(buildWhatsAppShareUrl('a b&c')).toBe('https://wa.me/?text=a%20b%26c');
  });
});
