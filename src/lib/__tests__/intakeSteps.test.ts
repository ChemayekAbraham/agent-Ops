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

describe('the E127 reply shapes', () => {
  const base = { ok: true, own_phone: false, open_request: null, returned_request: null, message: null };

  it('intake_tenant_check: one case per status', () => {
    expect(parseIntakeTenantCheck({ ...base, status: 'ok' })).toEqual({ kind: 'ok' });
    expect(parseIntakeTenantCheck({ ...base, status: 'own_phone', ok: false, own_phone: true, message: 'This is your own phone number.' }))
      .toEqual({ kind: 'own_phone', message: 'This is your own phone number.' });
    expect(parseIntakeTenantCheck({ ...base, status: 'open_request', ok: false, open_request: { id: 'r1', mine: true, where: 'Tenant Ops' }, message: 'Already at Tenant Ops' }))
      .toEqual({ kind: 'open_request', mine: true, requestId: 'r1', where: 'Tenant Ops', message: 'Already at Tenant Ops' });
    expect(parseIntakeTenantCheck({ ...base, status: 'returned_mine', ok: false, returned_request: { id: 'r2', mine: true, reason: 'Blurry photo' } }))
      .toEqual({ kind: 'returned_request', mine: true, requestId: 'r2', reason: 'Blurry photo', message: null });
    expect(parseIntakeTenantCheck({ ...base, status: 'returned_other', ok: false, returned_request: { id: 'r3', mine: false, reason: 'x' }, message: 'Sent back to another agent' }))
      .toMatchObject({ kind: 'returned_request', mine: false, requestId: 'r3', message: 'Sent back to another agent' });
    expect(parseIntakeTenantCheck({ ok: false, reason: 'phone_incomplete', message: 'Type all 10 digits' }))
      .toEqual({ kind: 'phone_incomplete', message: 'Type all 10 digits' });
  });

  it('become_agent: { ok, already_agent }; PHONE_REQUIRED and AGENT_ROLE_DISABLED as error messages', () => {
    expect(parseBecomeAgent({ ok: true, already_agent: false }, null)).toEqual({ ok: true, alreadyAgent: false });
    expect(parseBecomeAgent({ ok: true, already_agent: true }, null)).toEqual({ ok: true, alreadyAgent: true });
    expect(parseBecomeAgent(null, { message: 'PHONE_REQUIRED: confirm your phone first' })).toEqual({ ok: false, code: 'PHONE_REQUIRED', message: 'confirm your phone first' });
    expect(parseBecomeAgent(null, { message: 'AGENT_ROLE_DISABLED' })).toMatchObject({ ok: false, code: 'AGENT_ROLE_DISABLED' });
    expect(parseBecomeAgent(null, { message: 'boom' })).toEqual({ ok: false, code: 'OTHER', message: 'boom' });
  });

  it('return_items_for: { items, note, by, at }; [] when nothing was named', () => {
    expect(parseReturnItems({ items: ['tenant_photo', 'id_front'], note: 'Blurry', by: 'u1', at: '2026-11-16T10:00:00Z' }))
      .toEqual([{ code: 'tenant_photo', label: null }, { code: 'id_front', label: null }]);
    expect(parseReturnItems({ items: [], note: null, by: null, at: null })).toEqual([]);
    expect(parseReturnItems(null)).toBeNull();
  });
});
