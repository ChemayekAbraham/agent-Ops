import { describe, it, expect } from 'vitest';
import { isAgentCollectionsCoachingQuery, buildAgentCollectionsCoachingGuideReply, buildNexaPublicGuideReply } from '@/lib/nexaSalesEngine';
import { isPersonalAgentWorkQuery } from '@/lib/assistantRouting';

describe('collections coaching playbook', () => {
  it('detects coaching questions', () => {
    expect(isAgentCollectionsCoachingQuery('How can I improve my collections?')).toBe(true);
    expect(isAgentCollectionsCoachingQuery('What should I do with late tenants who are not paying?')).toBe(true);
    expect(isAgentCollectionsCoachingQuery('What is welile?')).toBe(false);
  });
  it('reply has all four points', () => {
    const r = buildAgentCollectionsCoachingGuideReply();
    expect(r).toMatch(/never use police/i);
    expect(r).toContain('UGX 30,000,000');
    expect(r).toContain('+UGX 10,000/day');
    expect(r).toContain('70% repayment');
    expect(r).toContain('https://welileapp.com/dashboard/agent');
    expect(r).toContain('https://welileapp.com/tenants-onboarding');
  });
  it('public guide and routing use the playbook', () => {
    expect(buildNexaPublicGuideReply('How can I get my tenants to pay on time?')).toContain('70% repayment');
    expect(isPersonalAgentWorkQuery('How can I improve my collections?')).toBe(false);
    expect(isPersonalAgentWorkQuery('How much have I collected today?')).toBe(true);
  });
});
