import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
let roles: string[] = [];
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles }) }));

import { DESKS, DESK_ALIASES } from '../deskConfig';
import { DESK_LINKS, canOpenDesk, type DeskLinkId } from '../deskLink';
import type { MyAccess } from '../deskAccess';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';
import { LandlordOpsSidebar } from '@/components/executive/landlord-ops/LandlordOpsSidebar';
import { TenantOpsSidebar } from '@/components/executive/tenant-ops/TenantOpsSidebar';
import { PartnerOpsSidebar } from '@/components/executive/partner-ops/PartnerOpsSidebar';

const open: MyAccess = { enforced: false, employee: true, all: false, desks: [], desk: null, sc_person: false, can_manage: false };

beforeEach(() => {
  rpcMock.mockReset();
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'desk_my_access'
        ? { data: open, error: null }
        : fn === 'desk_my_sc_scope'
          ? { data: { is_sc_person: false, open_new: null, open_batch: null, staff_ref: null }, error: null }
          : { data: null, error: null },
    ),
  );
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

/* ───────────── every route is one the desk router knows ───────────── */

describe('desk links', () => {
  it('point at routes the desk router already has', () => {
    const ids = new Set(DESKS.map((d) => d.id));
    for (const [id, link] of Object.entries(DESK_LINKS)) {
      const slug = link.route.replace(/^\/desk\//, '');
      expect(ids.has(DESK_ALIASES[slug] ?? slug)).toBe(true);
      expect(DESK_ALIASES[slug] ?? slug).toBe(id);
    }
  });
});

/* ───────────── one rule per role: shown for the role, hidden for others ───────────── */

const ROLE_FOR: Record<DeskLinkId, string> = {
  'service-centre': 'operations',
  'agent-ops': 'agent_ops',
  'tenant-ops': 'tenant_ops',
  'landlord-ops': 'landlord_ops',
  'partner-ops': 'partner_ops',
  cfo: 'cfo',
};
/** Roles that hold no desk at all, plus each other desk's own role. */
const OUTSIDERS = ['agent', 'tenant', 'supporter', 'hr', 'cmo', 'employee'];

describe.each(Object.keys(ROLE_FOR) as DeskLinkId[])('%s desk entry', (desk) => {
  it(`shows for ${ROLE_FOR[desk]}`, () => {
    expect(canOpenDesk(desk, [ROLE_FOR[desk]], open)).toBe(true);
  });

  it('is hidden for people the desk does not let in', () => {
    for (const r of OUTSIDERS) expect(canOpenDesk(desk, [r], open)).toBe(false);
    const others = Object.entries(ROLE_FOR).filter(([d, r]) => d !== desk && !DESKS.find((x) => x.id === desk)!.roles.includes(r));
    for (const [, r] of others) expect(canOpenDesk(desk, [r], open)).toBe(false);
  });

  it('is hidden until desk access has answered, and follows HR once it is switched on', () => {
    expect(canOpenDesk(desk, [ROLE_FOR[desk]], undefined)).toBe(false);
    expect(canOpenDesk(desk, [ROLE_FOR[desk]], { ...open, enforced: true, desks: [] })).toBe(false);
    expect(canOpenDesk(desk, [ROLE_FOR[desk]], { ...open, enforced: true, desks: [desk.replace(/-/g, '_')] })).toBe(true);
    expect(canOpenDesk(desk, ['coo'], { ...open, enforced: true, all: true })).toBe(true);
  });
});

describe('Service Centre person with no desk role', () => {
  it('opens only the Service Centre desk', () => {
    expect(canOpenDesk('service-centre', ['agent'], open, true)).toBe(true);
    expect(canOpenDesk('agent-ops', ['agent'], open, true)).toBe(false);
  });
});

describe('CFO', () => {
  it('already carries the desk in its sidebar, second after Home, like "COO desk"', () => {
    const cfoItems = executiveSidebarConfig.cfo[0].items;
    const cooItems = executiveSidebarConfig.coo[0].items;
    expect(cooItems[1]).toMatchObject({ label: 'COO desk', route: '/desk/coo' });
    expect(cfoItems[1]).toMatchObject({ label: 'Funders Dashboard', route: DESK_LINKS.cfo.route });
    expect(DESK_ALIASES.funders).toBe('cfo');
  });
});

/* ───────────── the dashboards' side tabs ───────────── */

const deskLink = (id: string) => document.querySelector(`[data-desk-link="${id}"]`);

describe('Landlord Ops sidebar (desktop and the phone menu sheet)', () => {
  it('shows "Landlord Ops desk" to Landlord Ops', async () => {
    roles = ['landlord_ops'];
    wrap(<LandlordOpsSidebar activePath="" onNavigate={() => {}} />);
    expect((await screen.findByText('Landlord Ops desk')).closest('[data-desk-link]')).toBeTruthy();
  });
  it('hides it from roles the desk does not let in', async () => {
    roles = ['hr'];
    wrap(<LandlordOpsSidebar activePath="" onNavigate={() => {}} />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_my_access', {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(deskLink('landlord-ops')).toBeNull();
  });
});

describe('Tenant Ops sidebar (desktop and the phone menu sheet)', () => {
  it('shows "Tenant Ops desk" to Tenant Ops', async () => {
    roles = ['tenant_ops'];
    wrap(<TenantOpsSidebar active="home" onSelect={() => {}} />);
    expect(await screen.findByText('Tenant Ops desk')).toBeTruthy();
  });
  it('hides it from roles the desk does not let in', async () => {
    roles = ['cmo'];
    wrap(<TenantOpsSidebar active="home" onSelect={() => {}} />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_my_access', {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(deskLink('tenant-ops')).toBeNull();
  });
});

describe('Partner Ops sidebar (desktop and the phone menu sheet)', () => {
  it('shows "Partner Ops desk" to Partner Ops', async () => {
    roles = ['partner_ops'];
    wrap(<PartnerOpsSidebar active={'home' as never} onSelect={() => {}} />);
    expect(await screen.findByText('Partner Ops desk')).toBeTruthy();
  });
  it('hides it from roles the desk does not let in', async () => {
    roles = ['landlord_ops'];
    wrap(<PartnerOpsSidebar active={'home' as never} onSelect={() => {}} />);
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('desk_my_access', {}));
    await new Promise((r) => setTimeout(r, 0));
    expect(deskLink('partner-ops')).toBeNull();
  });
});
