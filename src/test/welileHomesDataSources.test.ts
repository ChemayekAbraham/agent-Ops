/**
 * The Welile Homes landlord/float desks once queried `rent_plans`, `tenants` and
 * `landlord_float_allocations` — none of which exist in the database. Because the
 * calls sat inside try/catch (or behind `as any`), nothing failed loudly: the
 * "this landlord still has an active Rent Plan" deletion safeguard simply never
 * fired. This test keeps the data sources of those files pinned to real relations.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TYPES_PATH = path.join(REPO_ROOT, 'src/integrations/supabase/types.ts');

/** Relations the generated client knows about (tables, views, functions, enums). */
function knownRelations(): Set<string> {
  const types = readFileSync(TYPES_PATH, 'utf8');
  return new Set([...types.matchAll(/^      ([a-z_0-9]+): \{$/gm)].map((m) => m[1]));
}

/**
 * Database `.from('x')` calls only — `supabase.storage.from('bucket')` targets a
 * storage bucket, not a table, so those are skipped.
 */
function databaseTableRefs(source: string): string[] {
  const refs: string[] = [];
  const re = /\.from\(\s*['"]([a-z_0-9]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const before = source.slice(Math.max(0, m.index - 9), m.index);
    if (before.endsWith('.storage')) continue;
    refs.push(m[1]);
  }
  return refs;
}

const FILES = [
  'src/components/agent/AgentWelileHomesSheet.tsx',
  'src/components/coo/COOWelileHomesApprovalDesk.tsx',
  'src/components/executive/tenant-ops/TenantOpsWelileHomesReviewDesk.tsx',
];

describe('Welile Homes desks query only relations that exist', () => {
  const known = knownRelations();

  it('the generated types cover the tables these desks rely on', () => {
    // Guards against the test silently passing because types.ts was not found.
    expect(known.size).toBeGreaterThan(100);
    for (const t of ['rent_requests', 'landlords', 'agent_landlord_float_allocations', 'float_requests']) {
      expect(known.has(t)).toBe(true);
    }
  });

  for (const file of FILES) {
    it(`${path.basename(file)} references no missing table`, () => {
      const refs = [...new Set(databaseTableRefs(readFileSync(path.join(REPO_ROOT, file), 'utf8')))];
      expect(refs.length).toBeGreaterThan(0);
      const missing = refs.filter((r) => !known.has(r));
      expect(missing, `${file} queries relation(s) absent from the schema: ${missing.join(', ')}`).toEqual([]);
    });
  }

  it('the landlord deletion guard still checks active Rent Plans, tenants and float', () => {
    const src = readFileSync(path.join(REPO_ROOT, 'src/components/agent/AgentWelileHomesSheet.tsx'), 'utf8');
    const guard = src.slice(src.indexOf('// 4. Guard against rent plans'));
    expect(guard).toContain("from('rent_requests')");
    expect(guard).toContain('ACTIVE_RENT_STATUSES');
    expect(guard).toContain("from('landlords')");
    expect(guard).toContain("from('agent_landlord_float_allocations')");
    // The guard must never fall back to the tables that do not exist.
    expect(guard).not.toMatch(/from\('(rent_plans|tenants|landlord_float_allocations)'\)/);
  });
});
