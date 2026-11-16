import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

import { INTAKE_STEP_KEYS, firstIncompleteStep, intakeCounter, intakeLeftLabel, type IntakeState } from '@/lib/intakeSteps';
import { parseBecomeAgent, parseIntakeTenantCheck, parseReturnItems } from '@/lib/intakeRpc';
import { FUNNEL_STEPS } from '@/lib/formFunnel';

const state = (done: string[]): IntakeState =>
  Object.fromEntries(INTAKE_STEP_KEYS.map((k) => [k, [{ label: k, done: done.includes(k) }]])) as IntakeState;

describe('the 8 intake steps', () => {
  it('counter, "N left" label and the first incomplete step', () => {
    const s = state(['tenant', 'rent_plan', 'landlord', 'household', 'tenant_photo', 'lc1_post']);
    expect(intakeCounter(s, 'landlord')).toBe('Step 3 of 8 · 2 left');
    expect(intakeLeftLabel(s)).toBe('2 left: House, ID');
    expect(firstIncompleteStep(s)).toBe('house');
    expect(intakeCounter(s, 'id', 2)).toBe('2 to fix');
    expect(intakeLeftLabel(state([...INTAKE_STEP_KEYS]))).toBeNull();
  });

  it('every step name is a funnel step', () => {
    for (const k of INTAKE_STEP_KEYS) expect(FUNNEL_STEPS).toContain(k);
  });
});

describe('the E124 replies, read tolerantly', () => {
  it('intake_tenant_check', () => {
    expect(parseIntakeTenantCheck({ status: 'ok' })).toEqual({ kind: 'ok' });
    expect(parseIntakeTenantCheck(null)).toEqual({ kind: 'ok' });
    expect(parseIntakeTenantCheck({ result: 'OWN_PHONE' })).toMatchObject({ kind: 'own_phone' });
    expect(parseIntakeTenantCheck([{ code: 'open_request', stage: 'Tenant Ops', rent_request_id: 'r1', is_mine: true }]))
      .toMatchObject({ kind: 'open_request', stage: 'Tenant Ops', requestId: 'r1', mine: true });
    expect(parseIntakeTenantCheck({ status: 'returned_request', agent_id: 'me', id: 'r2' }, 'me')).toMatchObject({ kind: 'returned_request', mine: true, requestId: 'r2' });
    expect(parseIntakeTenantCheck({ status: 'returned_request', agent_id: 'other' }, 'me')).toMatchObject({ mine: false });
  });

  it('become_agent', () => {
    expect(parseBecomeAgent({ ok: true }, null)).toEqual({ ok: true });
    expect(parseBecomeAgent(null, { message: 'PHONE_REQUIRED' })).toMatchObject({ ok: false, code: 'PHONE_REQUIRED' });
    expect(parseBecomeAgent({ ok: false, code: 'AGENT_ROLE_DISABLED', message: 'Switched off' }, null)).toMatchObject({ code: 'AGENT_ROLE_DISABLED', message: 'Switched off' });
    expect(parseBecomeAgent(null, { message: 'boom' })).toMatchObject({ ok: false, code: 'OTHER', message: 'boom' });
  });

  it('return_items_for', () => {
    expect(parseReturnItems(['Tenant_Photo', 'id_front'])).toEqual([{ code: 'tenant_photo', label: null }, { code: 'id_front', label: null }]);
    expect(parseReturnItems({ items: [{ item: 'gps', label: 'GPS is far from the house' }] })).toEqual([{ code: 'gps', label: 'GPS is far from the house' }]);
    expect(parseReturnItems('not json')).toBeNull();
  });
});
