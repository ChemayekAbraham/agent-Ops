import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = vi.hoisted(() => ({ texts: [] as string[], saved: [] as string[] }));

vi.mock('jspdf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('jspdf')>();
  const Base = mod.default as unknown as new (...args: unknown[]) => Record<string, (...a: unknown[]) => unknown>;
  // Same document, but it records every piece of text drawn and never touches the disk.
  class Recording extends Base {
    constructor(...args: unknown[]) {
      super(...args);
      const text = this.text.bind(this);
      this.text = (t: unknown, ...rest: unknown[]) => {
        captured.texts.push(Array.isArray(t) ? t.join(' ') : String(t));
        return text(t, ...rest);
      };
      this.save = (name: unknown) => { captured.saved.push(String(name)); return this; };
    }
  }
  return { ...mod, default: Recording, jsPDF: Recording };
});

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: null } }) },
    from: () => ({ insert: async () => ({ error: null }) }),
  },
}));

import { generateAgentMonitoringPdf } from './agentMonitoringReportPdf';
import type { UncoveredPlanRow } from './agentMonitoringUncovered';

const plan = (i: number, bucket: UncoveredPlanRow['bucket']): UncoveredPlanRow => ({
  id: `p${i}`, bucket, tenantId: `t${i}`, tenantName: `Tenant ${i}`, tenantPhone: '+256700000000', agentId: 'a1', agentName: 'Agent One',
  fundedAmount: 400_000, totalRepayment: 520_000, repaid: bucket === 'awaiting_landlord' ? 0 : 50_000 * i, stillOwed: 520_000, fundedOn: '2026-10-01',
  daysSinceFunding: i, payout: { kind: 'none', paidAmount: 0, allocatedAmount: 0 }, pipelineStatus: 'funded',
});

const base = {
  day: new Date(2026, 9, 12), cohortLabel: 'All agents', frequencyLabel: 'All plans', statusLabel: 'All', search: '', agents: [],
};

describe('generateAgentMonitoringPdf with the two uncovered lists', () => {
  beforeEach(() => { captured.texts.length = 0; captured.saved.length = 0; });

  it('adds a section for each list with its own summary', async () => {
    await generateAgentMonitoringPdf({
      ...base,
      uncovered: {
        tenantPaying: [plan(1, 'tenant_paying_no_landlord'), plan(2, 'tenant_paying_no_landlord')],
        awaiting: [plan(3, 'awaiting_landlord')],
        asOf: '2026-10-12',
      },
    });
    const all = captured.texts.join('\n');
    expect(all).toContain('Tenant paying, landlord not paid');
    expect(all).toContain('Awaiting landlord payment');
    expect(all).toMatch(/2 Rent Plans · UGX 150,000 repaid so far · UGX 1,040,000 still owed/);
    expect(all).toMatch(/1 Rent Plans · UGX 400,000 funded, not yet paid to landlords · longest wait 3 days/);
    expect(all).toContain('Tenant 2');
    expect(all).toContain('Tenant 3');
    expect(captured.saved).toEqual(['agent-monitoring-2026-10-12.pdf']);
  });

  it('prints an empty line for a list with no Rent Plans', async () => {
    await generateAgentMonitoringPdf({ ...base, uncovered: { tenantPaying: [], awaiting: [], asOf: '2026-10-12' } });
    expect(captured.texts.join('\n')).toContain('No Rent Plan is in this position right now.');
  });

  it('is unchanged when the lists are not supplied', async () => {
    await expect(generateAgentMonitoringPdf(base)).resolves.toBe('agent-monitoring-2026-10-12.pdf');
    expect(captured.texts.join('\n')).not.toContain('Awaiting landlord payment');
  });
});
