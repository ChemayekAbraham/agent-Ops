import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_TERM_MONTHS } from '@/lib/contractTerm';

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');

describe('self-support contract term', () => {
  it('the screen constant equals the term the database enforces', () => {
    const file = readdirSync(migrationsDir).find((f) => f.endsWith('_self_support_twelve_month_term.sql'));
    expect(file, 'the 12-month term migration must exist').toBeTruthy();
    const sql = readFileSync(join(migrationsDir, file!), 'utf8');
    const m = /FUNCTION public\.psm_contract_term_months\(\)[\s\S]*?SELECT\s+(\d+)/i.exec(sql);
    expect(m, 'psm_contract_term_months() must return a literal').toBeTruthy();
    expect(Number(m![1])).toBe(CONTRACT_TERM_MONTHS);
  });

  it('no screen asks for a one-month term any more', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.(tsx?|jsx?)$/.test(e.name) || p.includes('integrations')) continue;
        if (/p_term_months:\s*1\b/.test(readFileSync(p, 'utf8'))) offenders.push(p);
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });

  it('keeps the house-activation migration parked so it can never run', () => {
    const live = readdirSync(migrationsDir).filter((f) => /empty_house_support_activation/.test(f));
    expect(live).toEqual([]);
    const parked = readFileSync(
      join(process.cwd(), 'docs', 'pending-changes', 'empty_house_support_activation.sql'), 'utf8');
    expect(parked.startsWith('-- STAGED, NOT APPLIED')).toBe(true);
  });
});
