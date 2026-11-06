import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn(), storage: { from: vi.fn() } } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import { fundersLine, pushQueueLine } from '../PushQueueCards';
import { DESKS } from '../deskConfig';

describe('budgets retired 5 Nov', () => {
  it('COO push queue and Funders board lines', () => {
    expect(pushQueueLine({ n: 113, ugx: 52_800_000 })).toBe('113 waiting for your push · UGX 52.8M');
    expect(fundersLine({ n: 1, ugx: 300_000, held: 0 })).toBe('1 listed · UGX 300k · 0 held');
    expect(pushQueueLine(null)).toBe('0 waiting for your push · UGX 0');
  });

  it('no desk question, lead, tile or table note mentions a budget', () => {
    const g = () => 'X';
    const copy = DESKS.flatMap((d) => [
      d.question,
      d.lead(g),
      ...d.tiles.flatMap((t) => [t.label, t.field, t.sub?.label ?? '', t.sub?.field ?? '']),
      ...d.tables.flatMap((t) => [t.title, t.note ?? '']),
    ]).join('\n');
    expect(copy).not.toMatch(/budget/i);
  });
});
