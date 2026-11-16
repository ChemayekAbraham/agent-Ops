/*
 * Author: SSENKAALI PIUS
 * Email: ssenkaali.pius@welileapp.com
 * Date: 2026-11-13
 * Website: welileapp.com
 */

/**
 * A funder booking empty houses for themselves says so (self_booking), so the server uses the funder's own details
 * and links the note to them. Without the flag the server keeps the typed partner details, which is what a proxy
 * agent's note for a partner needs (migration 20261123090000).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => rpc(...args),
    functions: { invoke: vi.fn(() => Promise.resolve({ data: null, error: null })) },
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useAuthenticatedPoll', () => ({
  requireUserSession: vi.fn(),
  useAuthenticatedAudience: () => false,
  isUnauthenticatedRpcError: () => false,
}));

import { submitPreviewSupport } from './useFunderPreviewSupport';
import type { FunderNewSelectionItem } from '@/components/funder-new/types';

const house = { id: 'h1', category: 'empty', amount: 200_000 } as unknown as FunderNewSelectionItem;

beforeEach(() => {
  rpc.mockReset();
  rpc.mockImplementation((name: string) =>
    Promise.resolve(
      name === 'agent_create_promissory_note_for_houses'
        ? { data: { note: { id: 'note-1' } }, error: null }
        : { data: null, error: null },
    ),
  );
});

describe('submitPreviewSupport: booking empty houses for yourself', () => {
  it('sends self_booking with the funder’s own details, then funds the booking', async () => {
    const result = await submitPreviewSupport([house], { fullName: 'Pius Funder', phone: '0700123456', email: 'pius@test.local' });
    const [name, args] = rpc.mock.calls[0];
    expect(name).toBe('agent_create_promissory_note_for_houses');
    expect(args.p_payload).toMatchObject({ partner_name: 'Pius Funder', whatsapp_number: '0700123456', self_booking: true });
    expect(args.p_house_ids).toEqual(['h1']);
    expect(rpc.mock.calls[1][0]).toBe('funder_fund_booked_houses');
    expect(result.reference).toBe('note-1');
  });
});
