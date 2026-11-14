// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('reported API request contracts', () => {
  it('does not embed profiles through the nonexistent user_roles foreign key', () => {
    const file = source('src/components/cfo/ProxyAgentManager.tsx');
    expect(file).not.toContain('profiles:user_id(');
    expect(file).toMatch(/from\('user_roles'\)\s*\.select\('user_id'\)/);
    expect(file).toMatch(/from\('profiles'\)\s*\.select\('id, full_name, phone'\)\s*\.in\('id', userIds.slice/);
  });

  for (const name of ['welile-ai-chat', 'whatsapp-webhook']) {
    it(`${name} skips the nonexistent learned-knowledge table`, () => {
      expect(source(`supabase/functions/${name}/index.ts`)).not.toMatch(/\.from\(['"]nexa_learned_knowledge['"]\)/);
    });
  }

  it('broadcast reads the verified suppression source and fails closed on errors', () => {
    const file = source('supabase/functions/coo-broadcast-partners/index.ts');
    expect(file).not.toContain(".from('email_suppressions')");
    expect(file).toMatch(/from\('suppressed_emails'\)\.select\('email'\)\.in\('email', slice\)/);
    expect(file).toContain('if (suppressionError) throw suppressionError;');
  });

  for (const path of ['src/pages/ResolveRLink.tsx', 'src/pages/TrackedRedirect.tsx', 'src/components/partner/SelfPortfolioFundingCard.tsx']) {
    it(`${path} does not request a singular short-link response`, () => {
      const file = source(path);
      expect(file).toMatch(/rpc\('resolve_short_link', \{ p_code: code \}\)\s*\.limit\(1\)/);
      expect(file).not.toMatch(/rpc\('resolve_short_link', \{ p_code: code \}\)\s*\.(?:single|maybeSingle)\(/);
    });
  }
});