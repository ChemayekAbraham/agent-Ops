import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), 'utf8');

describe('compounding email is built on the server', () => {
  const page = read('src', 'components', 'coo', 'COOPartnersPage.tsx');

  it('both compound actions only ask the server to send the email', () => {
    const calls = page.match(/functions\s*\.?\s*invoke\(\s*'send-portfolio-compound-email'/g) ?? [];
    expect(calls.length).toBe(2);
  });

  it('the page no longer assembles the email or sends the template itself', () => {
    expect(page).not.toContain("templateName: 'partner-portfolio-compounded'");
    expect(page).not.toContain('compound_history');
    expect(page).not.toContain('initial_partnership_amount');
    expect(page).not.toContain('buildCompoundProjection');
  });

  it('the server reads recorded facts, and only the service role may call that function', () => {
    const sql = read('supabase', 'migrations', '20261027120000_compound_email_facts.sql');
    expect(sql).toMatch(/FUNCTION public\.portfolio_compound_email_facts/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.portfolio_compound_email_facts\(uuid, text\) TO service_role/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.portfolio_compound_email_facts\(uuid, text\) FROM PUBLIC, anon, authenticated/);
  });

  it('the edge function is staff-only, supports a dry run, and keys one email per compound', () => {
    const fn = read('supabase', 'functions', 'send-portfolio-compound-email', 'index.ts');
    expect(fn).toContain('is_welile_staff');
    expect(fn).toContain('dry_run');
    expect(fn).toContain('compoundEmailIdempotencyKey');
  });
});
