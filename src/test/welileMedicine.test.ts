import { describe, it, expect } from 'vitest';
import { Stethoscope } from 'lucide-react';
import { buildMedicineSignupLink, medicineSmartphoneFields, generateReceiptNumber, computeMedicalGateSummary, computeMedicalTxSummary, type MedicalGateLogRow, type MedicalTransactionRow } from '@/lib/welileMedicine';
import { computeMedicineKpis } from '@/components/executive/agent-ops-v2/WelileMedicineOps';
import { BUSINESS_AREAS, ALL_DASHBOARD_FEATURES } from '@/components/executive/agentOpsFeatureRegistry';

const NOW = new Date('2026-10-24T12:00:00+03:00');
const gate = (o: Partial<MedicalGateLogRow>): MedicalGateLogRow => ({ id: o.id ?? crypto.randomUUID(), facility_id: 'f1', agent_id: 'a1', direction: 'in', person_name: 'Test Person', role_type: 'patient', recorded_at: '2026-10-24T08:00:00+03:00', ...o });
const tx = (o: Partial<MedicalTransactionRow>): MedicalTransactionRow => ({ id: o.id ?? crypto.randomUUID(), facility_id: 'f1', agent_id: 'a1', tx_direction: 'in', receipt_number: 'WM-RCP-TEST01', category: 'pharmacy_medicine', amount_ugx: 0, payment_method: 'cash', payer_or_payee_name: 'Test Payer', recorded_at: '2026-10-24T09:00:00+03:00', ...o });

describe('Welile Medicine rules', () => {
  it('builds the sign-up link with agent, facility and profile', () => {
    expect(buildMedicineSignupLink('a1', 'f1', 'p1')).toBe('https://welileapp.com/auth?ref=a1&facility=f1&profile=p1');
  });
  it('no smartphone joins the free smartphone queue; smartphone does not', () => {
    expect(medicineSmartphoneFields(false)).toEqual({ has_smartphone: false, smartphone_queue_status: 'queued' });
    expect(medicineSmartphoneFields(true)).toEqual({ has_smartphone: true, smartphone_queue_status: 'not_needed' });
  });
  it('receipt numbers use WM-RCP- plus 6 characters', () => {
    expect(generateReceiptNumber()).toMatch(/^WM-RCP-[A-Z0-9]{6}$/);
  });
});

const logs = [
  gate({ id: '1', person_name: 'Amina', profile_id: 'p1', direction: 'in', recorded_at: '2026-10-24T07:00:00+03:00' }),
  gate({ id: '2', person_name: 'Amina', profile_id: 'p1', direction: 'out', recorded_at: '2026-10-24T10:00:00+03:00' }),
  gate({ id: '3', person_name: 'Dr Test', role_type: 'doctor_clinician', direction: 'in' }),
  gate({ id: '4', person_name: 'Carer', role_type: 'caregiver_attendant', direction: 'in' }),
  gate({ id: '5', person_name: 'Yesterday', direction: 'in', recorded_at: '2026-10-23T08:00:00+03:00' }),
];
const txs = [
  tx({ id: 't1', tx_direction: 'in', amount_ugx: 25000 }),
  tx({ id: 't2', tx_direction: 'in', amount_ugx: 10000 }),
  tx({ id: 't3', tx_direction: 'out', category: 'drug_stock_supplier', amount_ugx: 50000 }),
  tx({ id: 't4', tx_direction: 'in', amount_ugx: 99000, recorded_at: '2026-10-23T09:00:00+03:00' }),
];

describe('Medical gate summary', () => {
  it('counts today only and tracks who is inside', () => {
    const s = computeMedicalGateSummary(logs, NOW);
    expect(s.enteredToday).toBe(3);
    expect(s.exitedToday).toBe(1);
    expect(s.currentlyInside).toBe(2);
    expect(s.byGroup.patient).toEqual({ in: 1, out: 1, inside: 0 });
    expect(s.byGroup.staff).toEqual({ in: 1, out: 0, inside: 1 });
    expect(s.byGroup.visitor).toEqual({ in: 1, out: 0, inside: 1 });
    expect(s.personStatus['p1'].direction).toBe('out');
  });
});

describe('Medical transactions summary', () => {
  it('sums receipts IN, payouts OUT and net cashflow in UGX for today', () => {
    const s = computeMedicalTxSummary(txs, NOW);
    expect(s.receiptsInCount).toBe(2);
    expect(s.payoutsOutCount).toBe(1);
    expect(s.moneyInTodayUgx).toBe(35000);
    expect(s.moneyOutTodayUgx).toBe(50000);
    expect(s.netCashflowTodayUgx).toBe(-15000);
    expect(s.allTimeInUgx).toBe(134000);
  });
});

describe('Agent Ops medicine KPIs', () => {
  it('combines facilities, profiles, gate, transactions and phone queue', () => {
    const k = computeMedicineKpis(
      [{ id: 'f1', facility_name: 'Test Clinic', facility_type: 'clinic', ownership: 'private', country: 'Uganda', district: 'Test', entry_point_name: 'Main Gate' }],
      [
        { id: 'p1', facility_id: 'f1', role_type: 'patient', full_name: 'Amina', smartphone_queue_status: 'queued' },
        { id: 'p2', facility_id: 'f1', role_type: 'nurse_midwife', full_name: 'Nurse', smartphone_queue_status: 'not_needed' },
      ],
      logs, txs, NOW,
    );
    expect(k.facilities).toBe(1);
    expect(k.profiles).toBe(2);
    expect(k.enteredToday).toBe(3);
    expect(k.exitedToday).toBe(1);
    expect(k.txInToday).toBe(2);
    expect(k.txOutToday).toBe(1);
    expect(k.moneyInTodayUgx).toBe(35000);
    expect(k.totalReceipts).toBe(4);
    expect(k.phonesQueued).toBe(1);
  });
});

describe('Welile Medicine as Business Area 16', () => {
  it('sits right after #15 Welile Schools', () => {
    const i = BUSINESS_AREAS.findIndex((b) => b.num === '15');
    expect(BUSINESS_AREAS[i + 1]).toMatchObject({ num: '16', title: 'Welile Medicine', section: 'welile-medicine', category: 'field' });
    expect(BUSINESS_AREAS[i + 1].icon).toBe(Stethoscope);
    const f = ALL_DASHBOARD_FEATURES.find((x) => x.id === 'core-16-welile-medicine');
    expect(f).toMatchObject({ section: 'welile-medicine', businessAreaNum: '16', isCoreBusinessArea: true });
  });
});
