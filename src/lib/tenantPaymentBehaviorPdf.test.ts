import { describe, it, expect, vi, beforeEach } from 'vitest';

// jsPDF builds its methods per instance, so the document is wrapped to record what is written and
// to keep the file from being downloaded.
const rec = vi.hoisted(() => ({ saved: [] as string[], texts: [] as string[] }));
vi.mock('jspdf', async (importOriginal) => {
  const mod = await importOriginal<typeof import('jspdf')>();
  const Base = mod.default as unknown as new (...a: unknown[]) => Record<string, (...args: unknown[]) => unknown>;
  class Recording extends Base {
    constructor(...a: unknown[]) {
      super(...a);
      const realText = this.text.bind(this);
      this.text = (...args: unknown[]) => {
        const t = args[0];
        rec.texts.push(Array.isArray(t) ? t.join(' ') : String(t));
        return realText(...args);
      };
      this.save = (name?: unknown) => { rec.saved.push(String(name)); return this; };
    }
  }
  return { ...mod, default: Recording, jsPDF: Recording };
});

import { generatePaymentBehaviorPdf } from './tenantPaymentBehaviorPdf';
import { reportDataFixture, overviewFixture } from '@/components/executive/tenant-ops/workspace/payment-behavior/paymentBehavior.fixtures';

const META = { periodLabel: '07 Sep 2026 to 06 Oct 2026', phrase: 'this period', filters: { agent: null, region: null, district: null, cadence: null } };

describe('generatePaymentBehaviorPdf', () => {
  beforeEach(() => { rec.saved.length = 0; rec.texts.length = 0; });

  it('builds a multi-page report, labels observed and estimated figures, and saves it by period', async () => {
    await generatePaymentBehaviorPdf(reportDataFixture, META);

    expect(rec.saved).toEqual(['Welile_Tenant_Payment_Behavior_20260907-20261006.pdf']);
    const all = rec.texts.join('\n');
    expect(all).toContain('Tenant Payment Behavior');
    expect(all).toContain('OBSERVED');
    expect(all).toContain('ESTIMATE');
    expect(all).toContain('5.1%');                                   // headline, straight from the server
    expect(all).toContain('UGX 1,757,731');                          // self-paid total (counted, as on Home)
    expect(all.replace(/\s+/g, ' ')).toContain('Paid ahead / above the bill: UGX 56,356,078 (1,333 payments). Not counted as collected, same as Home.');
    expect(all).toContain('SHAFEEQ SSENABULYA');                     // by-agent table
    expect(all).toContain('Ntege Dorothy');                          // follow-up list
    expect(all).toMatch(/Page \d+ of \d+/);
    expect(all).not.toMatch(/\b(loan|lender|ROI)\b/i);
  });

  it('states the selection when the report is filtered, and copes with empty groups', async () => {
    const empty = {
      ...reportDataFixture,
      overview: { ...overviewFixture, shift: { ...overviewFixture.shift, rows: [], counts: {} }, comparison: { ...overviewFixture.comparison, self_payers: null, agent_only: null } },
      trend: { ...reportDataFixture.trend, points: [], projection: { available: false as const, weeks_used: 2, reason: 'Fewer than four complete weeks.' } },
      byDimension: { agent: [], region: [], district: [], rent_band: [], cadence: [], cohort: [] },
    };
    await generatePaymentBehaviorPdf(empty, { ...META, filters: { agent: 'SHAFEEQ SSENABULYA', region: 'Central', district: null, cadence: 'daily' } });
    const all = rec.texts.join('\n');
    expect(rec.saved).toHaveLength(1);
    expect(all).toContain('Agent: SHAFEEQ SSENABULYA');
    expect(all).toContain('Region: Central');
    expect(all).toContain('Fewer than four complete weeks.');
    expect(all).toContain('Not enough days with payments');
  });
});
