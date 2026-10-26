import { describe, expect, it } from 'vitest';
import { buildNexaPublicGuideReply, buildNexaOfflineSalesReply, detectNexaSalesIntent, buildAccountPhoneAndDashboardGuideReply, buildInternalStaffRefusalReply } from '@/lib/nexaSalesEngine';

describe('Assistant starter intent routing', () => {
  it.each(['Requesting rent here', ' REQUESTING RENT?! ', 'get rent help'])('returns tenant guidance for %s', input => {
    expect(buildNexaPublicGuideReply(input)).not.toBeNull();
    expect(buildNexaOfflineSalesReply(input)).toBe(buildNexaPublicGuideReply(input));
  });
  it.each([['Requesting rent here', 'tenant'], ['requesting rent', 'tenant'], ['Supporting a tenant', 'supporter'], ['Anything about Welile', 'general']])('classifies %s as %s', (input, role) => {
    expect(detectNexaSalesIntent(input)).toBe(role);
  });
  it.each(['Supporting a tenant', ' SUPPORTING A TENANT?! ', 'Anything about Welile', 'What is Welile?'])('uses the shared public guide for %s', input => {
    expect(buildNexaPublicGuideReply(input)).not.toBeNull();
    expect(buildNexaOfflineSalesReply(input)).toBe(buildNexaPublicGuideReply(input));
  });
  it.each([
    ['Requesting rent here', '/register-tenant', 'tenant'],
    ['Supporting a tenant', '/dashboard/funder-new', 'supporter'],
  ])('preserves the sign-in target and signup role for %s', (input, target, role) => {
    const reply = buildNexaPublicGuideReply(input) ?? '';
    const paths = [...reply.matchAll(/\]\(([^)]+)\)/g)].map(match => new URL(match[1], 'https://welileapp.com'));
    expect(paths.some(url => url.pathname === '/auth' && url.searchParams.get('redirect') === target)).toBe(true);
    expect(paths.some(url => url.searchParams.get('signup') === '1' && url.searchParams.get('role') === role)).toBe(true);
    const signedIn = buildNexaPublicGuideReply(input, true) ?? '';
    const signedInPaths = [...signedIn.matchAll(/\]\(([^)]+)\)/g)].map(match => new URL(match[1], 'https://welileapp.com'));
    expect(signedInPaths.some(url => url.pathname === target)).toBe(true);
    expect(signedInPaths.some(url => url.pathname === '/auth')).toBe(false);
  });
  it.each(['Requesting rent here', 'Supporting a tenant', 'Anything about Welile'])('never bypasses account privacy for %s', input => {
    const privateInput = `${input}, my portfolio balance`;
    expect(buildNexaPublicGuideReply(privateInput)).toBe(buildAccountPhoneAndDashboardGuideReply(privateInput));
    const phoneInput = `${input}, 0700000000`;
    expect(buildNexaPublicGuideReply(phoneInput)).toBe(buildAccountPhoneAndDashboardGuideReply(phoneInput));
    expect(buildNexaPublicGuideReply(`${input}, company treasury`, true)).toBe(buildInternalStaffRefusalReply());
  });
});