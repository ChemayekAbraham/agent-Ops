import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync(path.join(process.cwd(), 'src/components/agent/AgentWelileHomesSheet.tsx'), 'utf8');

describe('Welile Homes: tenants need no SMS verification for float', () => {
  it('tenant selection and float request never gate on tenant_verified', () => {
    expect(src).not.toMatch(/&&\s*[st]\.tenant_verified/);
    expect(src).not.toMatch(/!\s*(s|t|target\?)\.tenant_verified/);
    expect(src).not.toContain('Tenant Verification Required');
  });

  it('enrolling a tenant no longer opens the tenant code dialog', () => {
    expect(src).not.toContain('<VerifyTenantDialog');
  });
});
