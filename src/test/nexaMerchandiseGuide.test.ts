import { describe, expect, it } from 'vitest';
import { isMerchandiseQuery, buildMerchandiseGuideReply, buildNexaPublicGuideReply, NEXA_ACTION_LINKS } from '@/lib/nexaSalesEngine';

describe('public merchandise guidance', () => {
  it.each([
    'how do I buy Welile merchandise?',
    'I want a press jacket',
    'order a khaki branded vest',
    'do you sell polo shirts?',
    'where can I get a jumper?',
    'T-shirts for agents',
    'company ID price',
    'staff badge',
    'signage and pull-up banner',
    'table mount and billboard',
    'order from the Welile merchandise store',
    'welile e-bike lease',
    'smartphone advance',
  ])('detects %s', input => {
    expect(isMerchandiseQuery(input)).toBe(true);
  });
  it.each(['hello', 'what is my portfolio balance?', 'how do I deposit into my wallet?', 'requesting rent support'])('does not classify unrelated %s', input => {
    expect(isMerchandiseQuery(input)).toBe(false);
  });
  it('shares the store, press jacket and order-tracking links with payment terms', () => {
    const reply = buildMerchandiseGuideReply(false);
    expect(reply).toContain('https://welileapp.com/merchandise');
    expect(reply).toContain('https://welileapp.com/m/welile-1rfmin');
    expect(reply).toContain('/merchandise?item=ec9493a7-75d8-441d-96eb-3550ffec3bb0');
    expect(reply).toContain('UGX 55,000');
    expect(reply).toContain('daily installments over 1–12 months with UGX 0 down');
    expect(reply).toContain('/auth?redirect=%2Fmerchandise%3Ftab%3Dorders');
  });
  it('links signed-in agents directly without auth gating', () => {
    const reply = buildMerchandiseGuideReply(true);
    expect(reply).toContain('[Open Welile Merchandise Store](/merchandise)');
    expect(reply).toContain('[Track My Orders](/merchandise?tab=orders)');
    expect(reply).not.toContain('/auth?redirect=');
  });
  it('routes merchandise questions through the guide before the financial fallback', () => {
    const reply = buildNexaPublicGuideReply('how do I buy a press jacket?', false);
    expect(reply).toBe(buildMerchandiseGuideReply(false));
  });
  it('exposes auth-gated merchandise links in NEXA_ACTION_LINKS', () => {
    expect(NEXA_ACTION_LINKS['/merchandise']).toContain('/auth?redirect=%2Fmerchandise');
    expect(NEXA_ACTION_LINKS['/merchandise?tab=orders']).toContain('/auth?redirect=%2Fmerchandise%3Ftab%3Dorders');
  });
});
