import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** Desk send-backs name what the agent must fix (an agent can only fix what is named), and say "Tenant's face photo". */

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
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['agent_ops'] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FIX_ITEMS, deskWords, itemsBlocked, itemsNote, toggleItem } from '../sendBackItems';
import { SendBackForm } from '../sendBack';
import { stageChecklist } from '../reviewApi';

const OPTIONS = [
  { code: 'agent', label: 'Field agent (to correct)', hint: 'Ends this round; the agent fixes and resubmits' },
  { code: 'service_centre', label: 'Service Centre', hint: 'Items to be checked again' },
];
const wrap = (ui: ReactNode) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

beforeEach(() => {
  rpcMock.mockReset();
  catalogue = [
    { code: 'TENANT_ID_MISSING', desks: ['Agent Ops'], meaning: 'Tenant ID not on file', requires_text: false },
    { code: 'OTHER', desks: ['all'], meaning: 'Reviewed weekly to create new codes', requires_text: true },
  ];
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'pipeline_send_back_options'
        ? { data: OPTIONS, error: null }
        : fn === 'pipeline_send_back_to'
          ? { data: { ok: true, to: 'agent', to_label: 'the field agent (to correct)' }, error: null }
          : { data: null, error: null },
    ),
  );
});

describe('the items', () => {
  it('the eleven items, in this order', () => {
    expect([...FIX_ITEMS]).toEqual(["Tenant's face photo", 'House photos', 'ID front', 'ID back', 'LC1 letter', 'Landlord', 'Rent', 'GPS', 'Family size', 'Work', 'Other']);
  });
  it('at least one item; "Other" needs a note; picks keep the list order', () => {
    expect(itemsBlocked([], 'anything')).toBe('Choose what the agent must fix.');
    expect(itemsBlocked(['Other'], 'short')).toMatch(/Other/);
    expect(itemsBlocked(['Other'], 'The tenant moved house')).toBeNull();
    expect(itemsBlocked(['GPS'], '')).toBeNull();
    expect(toggleItem(toggleItem([], 'LC1 letter'), "Tenant's face photo")).toEqual(["Tenant's face photo", 'LC1 letter']);
    expect(toggleItem(["Tenant's face photo", 'LC1 letter'], 'LC1 letter')).toEqual(["Tenant's face photo"]);
  });
  it('the note starts with the item names', () => {
    expect(itemsNote(["Tenant's face photo", 'LC1 letter'], ' Blurry, retake in daylight ')).toBe("[Tenant's face photo, LC1 letter] Blurry, retake in daylight");
    expect(itemsNote(['GPS'], '')).toBe('[GPS]');
  });
});

describe('every desk’s send-back form', () => {
  it('cannot send without an item; the note sent carries the item names first', async () => {
    wrap(<SendBackForm requestId="rr-1" stage="agent_ops" initial={{ to: 'agent' }} onDone={() => {}} />);
    await screen.findByText('Field agent (to correct)');
    fireEvent.click(await screen.findByRole('radio', { name: 'Tenant ID missing' }));
    const send = screen.getByRole('button', { name: 'Send back to Field agent (to correct)' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(document.querySelector('[data-send-back-blocked]')?.textContent).toBe('Choose what the agent must fix.');

    fireEvent.click(document.querySelector('[data-fix-item="LC1 letter"]') as HTMLElement);
    fireEvent.click(document.querySelector(`[data-fix-item="Tenant's face photo"]`) as HTMLElement);
    expect(document.querySelector(`[data-fix-item="Tenant's face photo"]`)?.getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Face photo blurry; LC1 letter unsigned' } });
    expect(send.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(send);
    });
    await waitFor(() => expect(rpcMock.mock.calls.some((c) => c[0] === 'pipeline_send_back_to')).toBe(true));
    expect(rpcMock.mock.calls.find((c) => c[0] === 'pipeline_send_back_to')![1]).toEqual({
      p_request_id: 'rr-1',
      p_from_stage: 'agent_ops',
      p_to: 'agent',
      p_reason_code: 'TENANT_ID_MISSING',
      p_note: "[Tenant's face photo, LC1 letter] Face photo blurry; LC1 letter unsigned",
    });
  });

  it('"Other" needs a note of its own', async () => {
    wrap(<SendBackForm requestId="rr-1" stage="agent_ops" initial={{ to: 'agent' }} onDone={() => {}} />);
    await screen.findByText('Field agent (to correct)');
    fireEvent.click(await screen.findByRole('radio', { name: 'Tenant ID missing' }));
    fireEvent.click(document.querySelector('[data-fix-item="Other"]') as HTMLElement);
    const send = screen.getByRole('button', { name: 'Send back to Field agent (to correct)' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(document.querySelector('[data-send-back-blocked]')?.textContent).toMatch(/Other/);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tenant moved to another house' } });
    expect(send.disabled).toBe(false);
  });
});

describe('wording', () => {
  it('"Tenant\'s face photo", never "passport photo", in the checks the desks show', () => {
    expect(deskWords('Passport photo is the TENANT')).toBe("Tenant's face photo shows the tenant");
    expect(deskWords("Is the tenant's passport photo clear?")).toBe("Is Tenant's face photo clear?");
    const sheet = { checklist: [{ stage: 'tenant_ops', code: 'to_passport_is_tenant', label: 'Passport photo is the TENANT', question: 'Does the passport photo show the tenant?' }] } as never;
    const [item] = stageChecklist(sheet, 'tenant_ops');
    expect(item.label).toBe("Tenant's face photo shows the tenant");
    expect(item.question).not.toMatch(/passport/i);
  });
});
