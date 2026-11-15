// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (path: string) => readFileSync(path, 'utf8');

describe('reported API request contracts', () => {
  it('daily rent landlord names use the registry name column', () => {
    const file = source('src/components/reports/DailyRentReport.tsx');
    expect(file).toMatch(/from\('landlords'\)\.select\('id, name'\)/);
    expect(file).toContain('map[l.id] = l.name');
  });

  it('landlord timeline queries only generated awareness-call columns', () => {
    const file = source('src/components/executive/landlord-ops/calling-center/LandlordTimelineDrawer.tsx');
    const types = source('src/integrations/supabase/types.ts');
    const row = types.match(/      rent_pipeline_awareness_calls: \{\n        Row: \{([\s\S]*?)\n        \}/)?.[1] ?? '';
    const columns = new Set([...row.matchAll(/          (\w+):/g)].map(m => m[1]));
    const calls = [...file.matchAll(/from\('rent_pipeline_awareness_calls'\)\s*\.select\(\s*'([^']+)'[\s\S]*?\.order\('([^']+)'/g)];
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      for (const column of call[1].split(',').map(c => c.trim())) expect(columns.has(column), column).toBe(true);
      expect(call[2]).toBe('recorded_at');
    }
    expect(file).toContain('occurredAt: aw.recorded_at');
    expect(file).not.toContain('landlord_called_at');
  });

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