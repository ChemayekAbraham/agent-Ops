import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
let catalogue: unknown[] = [];
const fromChain = {
  select: () => fromChain,
  eq: () => fromChain,
  in: () => fromChain,
  maybeSingle: () => Promise.resolve({ data: null, error: null }),
  order: () => Promise.resolve({ data: catalogue, error: null }),
};
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['service_center'] }) }));

import { SEND_BACK_STAGES, SUGGESTED_OFFICE, SendBackForm, isSendBackRow, officeLabel, parseSendBackNote } from '../sendBack';
import { GROUP_LABEL, PUSHABLE, isSendBackPush, primaryLabel } from '../boardApi';
import { DECISION_LABEL, visibleDecisions, type Stage } from '../reviewTypes';

const wrap = (ui: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

beforeEach(() => {
  rpcMock.mockReset();
  catalogue = [
    { code: 'ITEMS_MISSING', desks: ['Service Centre'], meaning: 'Items missing at intake', requires_text: false },
    { code: 'OTHER', desks: ['all'], meaning: 'Reviewed weekly to create new codes', requires_text: true },
    { code: 'TENANT_UNREACHABLE', desks: ['Tenant Ops'], meaning: 'Tenant could not be reached', requires_text: false },
  ];
});

describe('E64: Reject becomes "Send back" on the desks', () => {
  it('Service Centre, Agent Ops, Tenant Ops, Landlord Ops and COO offer Send back and no Reject', () => {
    for (const s of ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops', 'coo'] as Stage[]) {
      expect(visibleDecisions(s)).toContain('send_back');
      expect(visibleDecisions(s)).not.toContain('reject');
      expect(SEND_BACK_STAGES.has(s)).toBe(true);
    }
    // Older rejects still read as "Reject" in the history.
    expect(DECISION_LABEL.reject).toBe('Reject');
  });

  it('board rows: the system reject reads "Send back", opens the same sheet, and pushes through pipeline_send_back_to', () => {
    expect(isSendBackRow('reject', 'tenant_ops')).toBe(true);
    expect(isSendBackRow('send_back', 'service_centre')).toBe(true);
    expect(isSendBackRow('pass', 'agent_ops')).toBe(false);
    expect(isSendBackRow('send_back', 'partner_ops')).toBe(false);
    expect(isSendBackPush({ decision: 'reject' }, 'landlord_ops')).toBe(true);
    expect(isSendBackPush({ decision: 'send_back' }, 'service_centre')).toBe(true);
    expect(isSendBackPush({ decision: 'pass' }, 'agent_ops')).toBe(false);
    expect(GROUP_LABEL.reject).toBe('Send back to agent');
    // "Push all" still covers send-backs: each goes to the agent in the field with the server's reason (E63).
    expect(PUSHABLE).toEqual(['pass', 'transfer', 'send_back', 'reject']);
    const row = { decision: 'reject' } as unknown as Parameters<typeof primaryLabel>[0];
    expect(primaryLabel(row, 'tenant_ops')).toBe('Send back');
  });

  it('the field agent reads as the reject it is', () => {
    expect(officeLabel({ code: SUGGESTED_OFFICE, label: 'Field agent (to correct)' })).toBe('Agent in the field (rejected)');
    expect(officeLabel({ code: 'agent_ops', label: 'Agent Ops' })).toBe('Agent Ops');
  });

  it("history: the chosen office and the reason come out of the server's review note", () => {
    expect(parseSendBackNote('To Agent Ops: Photos are blurred, retake them')).toEqual({ office: 'Agent Ops', why: 'Photos are blurred, retake them' });
    expect(parseSendBackNote('To the field agent (to correct): Landlord refused')).toEqual({ office: 'Agent in the field (rejected)', why: 'Landlord refused' });
    expect(parseSendBackNote('Returned for correction')).toBeNull();
    expect(parseSendBackNote(null)).toBeNull();
  });
});

describe('E64: Service Centre sends back through pipeline_send_back_to', () => {
  const OPTIONS = [{ code: 'agent', label: 'Field agent (to correct)', hint: 'Ends this round; the agent fixes and resubmits' }];

  it('lists only the offices below it, starts on the agent when asked, needs a reason, then sends', async () => {
    rpcMock.mockImplementation((fn: string) => {
      if (fn === 'pipeline_send_back_options') return Promise.resolve({ data: OPTIONS, error: null });
      if (fn === 'pipeline_send_back_to') return Promise.resolve({ data: { ok: true, to: 'agent', to_label: 'the field agent (to correct)', status: 'rejected' }, error: null });
      return Promise.resolve({ data: null, error: null });
    });
    const onDone = vi.fn();
    wrap(<SendBackForm requestId="rr-1" stage="service_centre" initial={{ to: SUGGESTED_OFFICE }} onDone={onDone} />);
    const agent = await screen.findByText('Agent in the field (rejected)');
    expect(rpcMock).toHaveBeenCalledWith('pipeline_send_back_options', { p_from_stage: 'service_centre' });
    expect(agent.closest('[data-office]')?.getAttribute('aria-checked')).toBe('true');
    // Service Centre is the first office: nothing above the agent to choose.
    expect(document.querySelectorAll('[data-office]')).toHaveLength(1);

    const send = screen.getByRole('button', { name: 'Send back to Agent in the field (rejected)' });
    expect(send).toHaveProperty('disabled', true); // a reason is required
    const reasons = await screen.findAllByRole('radio', { name: /Items missing at intake|Reviewed weekly/ });
    expect(reasons.map((r) => r.getAttribute('data-reason'))).toEqual(['ITEMS_MISSING', 'OTHER']); // the Service Centre's own plus the shared ones
    fireEvent.click(within(document.body).getByRole('radio', { name: 'Items missing at intake' }));
    expect(send).toHaveProperty('disabled', false);
    await act(async () => {
      fireEvent.click(send);
    });
    expect(rpcMock).toHaveBeenCalledWith('pipeline_send_back_to', {
      p_request_id: 'rr-1',
      p_from_stage: 'service_centre',
      p_to: 'agent',
      p_reason_code: 'ITEMS_MISSING',
      p_note: null,
    });
    expect(onDone).toHaveBeenCalledWith('Sent back to the agent in the field: rejected.');
  });
});
