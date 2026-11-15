// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('rent request sibling query contracts', () => {
  const cases = [
    ['src/hooks/useCFOImpactDrilldown.ts', 'tenant_id, rent_amount, status, created_at'],
    ['src/components/executive/agent-ops-v2/AgentOpsOverview.tsx', 'id, agent_id, rent_amount, status, created_at, tenant_id'],
    ['src/components/executive/agent-ops-v2/drill/RentRequestsList.tsx', 'id, created_at, rent_amount, status, tenant_id'],
  ];
  for (const [path, columns] of cases) {
    it(`${path} reads the recorded rent amount`, () => {
      const source = readFileSync(path, 'utf8');
      expect(source).toContain(`.select('${columns}'`);
      expect(source).toMatch(/(?:Number|fmtMoney)\(r\.rent_amount/);
    });
  }
  it('live request inserts and updates use the same rent amount as initial reads', () => {
    const source = readFileSync(cases[2][0], 'utf8');
    expect(source.match(/Number\(r\.rent_amount/g)).toHaveLength(3);
    expect(source).not.toMatch(/Number\(r\.amount/);
  });
  it('rejected-request restoration reads the recorded property address', () => {
    const source = readFileSync('src/components/agent/AgentRentRequestDialog.tsx', 'utf8');
    expect(source).toContain("from('landlords').select('name, property_address')");
    expect(source).toContain('landlord_address: (landlordRow as any)?.property_address');
  });
});