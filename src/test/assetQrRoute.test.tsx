import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  storageFrom: vi.fn(),
  insert: vi.fn(),
  auth: { user: null as { id: string } | null, roles: [] as string[], loading: false },
  perms: [] as string[],
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: mocks.rpc,
    storage: { from: mocks.storageFrom },
    from: () => ({ insert: mocks.insert }),
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/hooks/useStaffPermissions', () => {
  const BYPASS_ROLES = ['super_admin', 'cto'];
  return {
    BYPASS_ROLES,
    ROLE_DASHBOARD_KEY: { cfo: 'cfo', super_admin: 'super_admin', coo: 'coo', ceo: 'ceo', cto: 'cto' },
    useStaffPermissions: () => {
      const isBypassed = mocks.auth.roles.some((r) => BYPASS_ROLES.includes(r));
      return { permissions: mocks.perms, isBypassed, loading: false, hasPermission: (k: string) => isBypassed || mocks.perms.includes(k) };
    },
  };
});
vi.mock('@/hooks/useRoleAccessRequests', () => ({ useRoleAccessRequests: () => ({ requests: [], requestRole: vi.fn(), loading: false }) }));
vi.mock('@/components/auth/PhoneVerificationGate', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/pages/NotFound', () => ({ default: () => <p>Page not found</p> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import RoleGuard from '@/components/auth/RoleGuard';
import SignInReturnGate from '@/components/auth/SignInReturnGate';
import AssetDetailPage from '@/pages/cfo/AssetDetail';
import { postSignInPath, safeInternalPath } from '@/lib/returnPath';
import { assetDetailPath, assetQrUrl } from '@/lib/assetRegister/qr';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const OTHER = '00000000-0000-4000-8000-000000000002';
const LEGACY = '00000000-0000-4000-8000-000000000003';

const asset = (id: string, code: string, name: string, tag: string | null, site: [string, string] | null) => ({
  id, asset_code: code, asset_tag: tag, site_key: site?.[0] ?? null, site_name: site?.[1] ?? null, name, category: 'it_equipment', brand: 'Dell', model: 'Latitude', serial_number: 'SN-1',
  purchase_date: '2025-01-15', supplier: 'Kampala Computers', purchase_cost: 3500000, currency: 'UGX',
  invoice_reference: 'INV-1', department_key: 'finance', department_name: 'Finance', location: 'Head office',
  custodian_user_id: null, custodian_name: 'Jane', custodian_display: 'Jane', condition: 'good', status: 'in_use',
  photo_paths: [`assets/${id}/11111111-1111-4111-8111-111111111111.jpg`], evidence_paths: [], notes: null,
  import_batch_id: null, created_by: 'u1', created_by_name: 'CFO User', created_at: '2026-10-26T08:00:00Z',
  updated_by: 'u1', updated_by_name: 'CFO User', updated_at: '2026-10-26T08:00:00Z',
});

const ASSETS: Record<string, ReturnType<typeof asset>> = {
  [ID]: asset(ID, 'WEL-AST-000001', 'Finance laptop', 'WEL-ICT-HQ-001', ['entebbe_hq', 'Entebbe Head Office']),
  [OTHER]: asset(OTHER, 'WEL-AST-000002', 'Board room table', 'WEL-ICT-KOL-002', ['kololo', 'Kololo']),
  [LEGACY]: asset(LEGACY, 'WEL-AST-000003', 'Old printer', null, null),
};

/** Server stand-in for asset_register_get: the same gate as asset_register_read_ok (cfo/super_admin). */
function serverGet(args: { p_id: string }) {
  if (!mocks.auth.user) return { data: null, error: { code: '42501', message: 'AUTH_REQUIRED' } };
  if (!mocks.auth.roles.some((r) => r === 'cfo' || r === 'super_admin')) {
    return { data: null, error: { code: '42501', message: 'NOT_AUTHORIZED' } };
  }
  const a = ASSETS[args.p_id];
  return a ? { data: { asset: a, events: [] }, error: null } : { data: null, error: { code: 'P0002', message: 'ASSET_NOT_FOUND' } };
}

function AuthProbe() {
  const loc = useLocation();
  return <p data-testid="auth-page">{loc.pathname}{loc.search}</p>;
}

// Same composition as the /cfo/assets/:assetId route in src/App.tsx (pinned by the source check below).
function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/auth" element={<AuthProbe />} />
          <Route path="/cfo/assets/:assetId" element={<SignInReturnGate><RoleGuard allowedRoles={['cfo', 'super_admin']} requiredPermission="cfo"><AssetDetailPage /></RoleGuard></SignInReturnGate>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const signIn = (roles: string[], perms: string[] = []) => {
  mocks.auth.user = { id: 'staff-1' };
  mocks.auth.roles = roles;
  mocks.perms = perms;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = null;
  mocks.auth.roles = [];
  mocks.auth.loading = false;
  mocks.perms = [];
  mocks.rpc.mockImplementation((fn: string, args: { p_id: string }) =>
    Promise.resolve(fn === 'asset_register_get' ? serverGet(args) : { data: null, error: { message: `unexpected ${fn}` } }));
  mocks.storageFrom.mockReturnValue({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://signed.example/x' }, error: null }) });
  mocks.insert.mockResolvedValue({ error: null });
});
afterEach(cleanup);

describe('App route for asset QR codes', () => {
  it('is registered in App.tsx with the sign-in return gate and CFO/Super Admin guard', () => {
    const app = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    expect(app).toContain(
      `<Route path="/cfo/assets/:assetId" element={<SignInReturnGate><RoleGuard allowedRoles={['cfo', 'super_admin']} requiredPermission="cfo"><AssetDetailPage /></RoleGuard></SignInReturnGate>} />`,
    );
    expect(app.match(/path="\/cfo\/assets\//g)).toHaveLength(1);
  });
});

describe('scanning an asset QR code', () => {
  it('signed out: goes to sign-in with a safe return path, and nothing is fetched', async () => {
    renderAt(assetDetailPath(ID));
    const probe = await screen.findByTestId('auth-page');
    expect(probe.textContent).toBe(`/auth?redirect=${encodeURIComponent(`/cfo/assets/${ID}`)}`);
    expect(safeInternalPath(`/cfo/assets/${ID}`)).toBe(`/cfo/assets/${ID}`);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it('CFO: opens the matching asset read-only, with evidence via a short-lived signed URL', async () => {
    signIn(['cfo'], ['cfo']);
    renderAt(assetDetailPath(OTHER));
    expect(await screen.findByText('Board room table')).toBeTruthy();
    // header: the tag prominently, the permanent code in small text; details repeat both plus the site
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('WEL-ICT-KOL-002');
    expect(heading.textContent).toContain('WEL-AST-000002');
    expect(within(heading).getByText('WEL-ICT-KOL-002').className).toMatch(/text-sm/);
    expect(within(heading).getByText('WEL-AST-000002').className).toMatch(/text-\[10px\]/);
    expect(screen.getAllByText('WEL-ICT-KOL-002')).toHaveLength(2);
    expect(screen.getByText('Kololo')).toBeTruthy();
    expect(screen.queryByText('Finance laptop')).toBeNull();
    expect(screen.queryByText('WEL-ICT-HQ-001')).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('asset_register_get', { p_id: OTHER });
    await waitFor(() => expect(mocks.storageFrom).toHaveBeenCalledWith('asset-evidence'));
    // read-only: no edit and no evidence upload
    expect(document.getElementById('asset-detail-edit')).toBeNull();
    expect(document.getElementById('asset-attach-photo')).toBeNull();
    expect(document.getElementById('asset-attach-evidence')).toBeNull();
  });

  it('every asset: its QR link opens that exact asset’s page, never the register list', async () => {
    signIn(['cfo'], ['cfo']);
    for (const a of Object.values(ASSETS)) {
      vi.clearAllMocks();
      mocks.rpc.mockImplementation((fn: string, args: { p_id: string }) =>
        Promise.resolve(fn === 'asset_register_get' ? serverGet(args) : { data: null, error: { message: `unexpected ${fn}` } }));
      const url = new URL(assetQrUrl(a.id));
      expect(url.pathname).toBe(`/cfo/assets/${a.id}`); // the uuid, not the code or tag
      const { unmount } = renderAt(url.pathname);
      expect(await screen.findByText(a.name)).toBeTruthy();
      expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(a.asset_tag ?? a.asset_code);
      for (const other of Object.values(ASSETS).filter((o) => o.id !== a.id)) expect(screen.queryByText(other.name)).toBeNull();
      expect(mocks.rpc.mock.calls).toEqual([['asset_register_get', { p_id: a.id }]]); // one detail read, no list query
      expect(screen.queryByLabelText('Search assets')).toBeNull(); // not the Asset Register list
      unmount();
    }
  });

  it('signed out: after sign-in the return path leads back to the same asset, not the dashboard list', async () => {
    const path = new URL(assetQrUrl(OTHER)).pathname;
    const first = renderAt(path);
    const probe = await first.findByTestId('auth-page');
    const redirect = new URLSearchParams(probe.textContent!.split('?')[1]).get('redirect');
    first.unmount();
    signIn(['cfo'], ['cfo']);
    const next = postSignInPath('staff-1', redirect); // what /auth navigates to once signed in
    expect(next).toBe(path);
    renderAt(next);
    expect(await screen.findByText('Board room table')).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith('asset_register_get', { p_id: OTHER });
  });

  it('Super Admin: opens the asset', async () => {
    signIn(['super_admin']);
    renderAt(assetDetailPath(ID));
    expect(await screen.findByText('Finance laptop')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('WEL-ICT-HQ-001');
    expect(screen.getByText('Entebbe Head Office')).toBeTruthy();
  });

  it('an asset registered before tags shows its permanent code and no invented tag', async () => {
    signIn(['cfo'], ['cfo']);
    renderAt(assetDetailPath(LEGACY));
    expect(await screen.findByText('Old printer')).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toContain('WEL-AST-000003');
    expect(heading.textContent).not.toMatch(/WEL-(ICT|FUR|OFE|VEH|MAC|OTH)-/);
    expect(screen.getByText(/Not issued/)).toBeTruthy();
  });

  it('accepts an upper-case uuid and asks the server for the lower-case id', async () => {
    signIn(['cfo'], ['cfo']);
    renderAt(`/cfo/assets/${ID.toUpperCase()}`);
    expect(await screen.findByText('Finance laptop')).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith('asset_register_get', { p_id: ID });
  });

  it.each([
    ['COO with a cfo dashboard grant', ['coo'], ['cfo']],
    ['CEO with a cfo dashboard grant', ['ceo'], ['cfo']],
    ['CTO (permission bypass but not an asset role)', ['cto'], []],
    ['tenant', ['tenant'], []],
  ])('%s: denied by the route guard, nothing fetched', async (_label, roles, perms) => {
    signIn(roles, perms);
    renderAt(assetDetailPath(ID));
    expect(await screen.findByText('Page not found')).toBeTruthy();
    expect(screen.queryByText('Finance laptop')).toBeNull();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it('server refusal (e.g. role revoked mid-session) shows no asset data and no evidence', async () => {
    signIn(['cfo'], ['cfo']);
    mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'NOT_AUTHORIZED' } });
    renderAt(assetDetailPath(ID));
    expect(await screen.findByText(/could not be found, or you do not have access/)).toBeTruthy();
    expect(screen.queryByText('Finance laptop')).toBeNull();
    expect(mocks.storageFrom).not.toHaveBeenCalled();
  });

  it('unknown asset shows the same message as a refusal', async () => {
    signIn(['cfo'], ['cfo']);
    renderAt(assetDetailPath('99999999-9999-4999-8999-999999999999'));
    expect(await screen.findByText(/could not be found, or you do not have access/)).toBeTruthy();
  });

  it.each(['WEL-AST-000001', 'not-a-uuid', `${ID}x`])('invalid id %s: no server call', async (bad) => {
    signIn(['cfo'], ['cfo']);
    renderAt(`/cfo/assets/${bad}`);
    expect(await screen.findByText(/could not be found, or you do not have access/)).toBeTruthy();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
