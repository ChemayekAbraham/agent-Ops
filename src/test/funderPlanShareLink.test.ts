import { describe, it, expect, vi } from 'vitest';
// The screen pulls hooks that import the Supabase client; this test needs no network.
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: () => Promise.resolve({ data: null, error: null }), from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }), in: () => Promise.resolve({ data: [], error: null }) }) }), auth: { getSession: () => Promise.resolve({ data: { session: null }, error: null }) } } }));
// The sales sheet prices its worked example at the viewer's own rate (15 while the switch is off).
vi.mock('@/hooks/usePartnerQuoteRate', () => ({
  useOwnNewPortfolioRate: () => ({ rate: 15, isLoading: false }),
}));
import { buildPlanShareLink, buildPlanShareMessage, buildWhatsAppShareUrl } from '@/components/funder-new/FunderNewSelectionPanel';

const item = { id: 'abc-123', category: 'ready' as const, tenantName: 'Test Tenant', tenantPhone: '+256700000000', landlordPhone: '0700000001' };

describe('support plan share link', () => {
  it('points to the public support page for this home', () => {
    expect(buildPlanShareLink(item, 'https://welileapp.com/')).toBe('https://welileapp.com/support/abc-123');
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
