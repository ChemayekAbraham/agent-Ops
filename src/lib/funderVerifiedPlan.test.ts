import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import { parseFunderVerifiedPlanPayload } from './funderVerifiedPlan';
import { buildFunderRentPlanDocument, buildFunderRentReceiptDocument } from './funderVerifiedPlanPdf';
import type { FunderVerifiedPlan } from './funderVerifiedPlan';

const funded: FunderVerifiedPlan = {
  rentRequestId: '11111111-1111-1111-1111-111111111111',
  verified: false,
  verificationLabel: null,
  status: 'funded',
  tenantName: 'Achieng <script>',
  tenantPhone: null,
  landlordName: 'Okello',
  landlordPhone: null,
  payoutMomoNumber: null,
  payoutMomoName: null,
  payoutMomoSource: null,
  houseCategory: 'Single room',
  location: 'Kira',
  rentAmount: 400000,
  dailyRepayment: 15000,
  totalRepayment: 450000,
  amountRepaid: 0,
  durationDays: 30,
  repaymentFrequency: 'daily',
  repaymentStartsOn: null,
  fundedAt: '2026-11-11T08:00:00Z',
  houseTitle: 'Room in Kira',
  funding: {
    recordedAt: '2026-11-11T08:00:00Z',
    amount: 400000,
    receiptNumber: 'PSF-ABC12345',
    reference: 'PSF-ABC12345',
    tid: null,
    funderName: 'Benjamin',
    agentName: 'Agnes',
    landlordHasDashboard: false,
    rentPaid: false,
    route: 'agent_will_withdraw',
    routeDetail: 'The landlord is not using a Welile dashboard. This rent is on Agnes\'s dashboard. Agnes will process the withdrawal for the landlord.',
    steps: [
      { key: 'funded', state: 'done', title: 'Funding recorded', detail: 'You funded this Rent Plan on 11 Nov 2026.' },
      { key: 'where', state: 'current', title: 'On the agent dashboard', detail: 'The landlord is not using a Welile dashboard. This rent is on Agnes\'s dashboard. Agnes will process the withdrawal for the landlord.' },
      { key: 'payout', state: 'waiting', title: 'Landlord payout', detail: 'Not paid to the landlord yet.' },
    ],
  },
  agreement: { version: null, status: 'not_accepted', acceptedAt: null },
};

describe('funder verified plan dossier', () => {
  it('hides landlord phone and mobile money when the plan is not verified', () => {
    const parsed = parseFunderVerifiedPlanPayload({
      ok: true,
      verified: false,
      rent_request_id: funded.rentRequestId,
      tenant_name: 'Achieng',
      landlord_name: 'Okello',
      landlord_phone: '0700111222',
      payout_momo_number: '0777000111',
      funding: {
        receipt_number: 'PSF-ABC12345',
        amount: 400000,
        funder_name: 'Benjamin',
        agent_name: 'Agnes',
        rent_paid: false,
        route: 'agent_will_withdraw',
        route_detail: 'Not paid to the landlord yet.',
        steps: funded.funding?.steps,
      },
    });
    expect(parsed.state).toBe('ready');
    if (parsed.state !== 'ready') return;
    expect(parsed.plan.verified).toBe(false);
    expect(parsed.plan.landlordPhone).toBeNull();
    expect(parsed.plan.payoutMomoNumber).toBeNull();
    expect(parsed.plan.funding?.rentPaid).toBe(false);
    expect(parsed.plan.funding?.steps[2].detail).toMatch(/Not paid/);
  });

  it('keeps the phone only when the server says the plan is verified', () => {
    const parsed = parseFunderVerifiedPlanPayload({
      ok: true,
      verified: true,
      rent_request_id: funded.rentRequestId,
      verification_label: 'Verified',
      landlord_name: 'Okello',
      landlord_phone: '0700111222',
      payout_momo_number: '0777000111',
      payout_momo_name: 'Okello Rent',
      payout_momo_source: 'approved',
      agreement: { status: 'accepted', version: 'v1.0', accepted_at: '2026-11-01T00:00:00Z' },
    });
    if (parsed.state !== 'ready') throw new Error(parsed.state);
    expect(parsed.plan.landlordPhone).toBe('0700111222');
    expect(parsed.plan.payoutMomoName).toBe('Okello Rent');
    expect(parsed.plan.agreement.status).toBe('accepted');
  });

  it('does not treat a missing plan as verified', () => {
    expect(parseFunderVerifiedPlanPayload({ ok: false, code: 'not_available' })).toEqual({
      state: 'hidden',
      code: 'not_available',
    });
  });
});

describe('funder rent receipt', () => {
  it('prints the branded header, the agent route, and no paid claim', () => {
    const html = buildFunderRentReceiptDocument(funded, { logoSrc: '/welile-logo.png', origin: 'https://welileapp.com' });
    expect(html).toContain('Welile Technologies Limited');
    expect(html).toContain('+256 777 607 640');
    expect(html).toContain('info@welile.com');
    expect(html).toContain('welile.com');
    expect(html).toContain('welileapp.com');
    expect(html).toContain('#7b19d4');
    expect(html).toContain('PSF-ABC12345');
    expect(html).toContain('Agnes will process the withdrawal');
    expect(html).not.toContain('Rent paid to the landlord');
    expect(html).not.toContain('\u2014');
    expect(html).toContain('Achieng &lt;script&gt;');
    const withFee = buildFunderRentReceiptDocument(funded, { logoSrc: '/welile-logo.png', origin: 'https://welileapp.com', coverFeeCharged: 6000 });
    expect(withFee).toContain('UGX 6,000 charged from your Welile wallet');
    expect(html).not.toContain('charged from your Welile wallet');
  });

  it('leaves the agreement off an unverified plan document', () => {
    const html = buildFunderRentPlanDocument(funded, { logoSrc: '/welile-logo.png', origin: 'https://welileapp.com' });
    expect(html).not.toContain('WELILE TENANT AGREEMENT');
    expect(html).toContain('will process the withdrawal');
  });
});
