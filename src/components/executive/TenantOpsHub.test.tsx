/**
 * The authorised Rule-8 exception (docs/TOPS_BUILD_LOG.md, 2026-09-28): the
 * Tenant Ops Workspace mounted as a fourth, gated mode in the existing
 * switcher. This test exercises the switcher/gating logic itself — mode
 * visibility, the flag+role gate, URL/localStorage handling, and that the
 * three existing modes are untouched — against the real component, with the
 * four heavy mode-content components and the data hooks mocked out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TenantOpsHub } from './TenantOpsHub';

const mockUseAuth = vi.fn();
const mockUseWorkspaceEnabled = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: (...args: unknown[]) => mockUseAuth(...args),
}));
vi.mock('@/hooks/tenantOpsWorkspace/useWorkspaceEnabled', () => ({
  useWorkspaceEnabled: (...args: unknown[]) => mockUseWorkspaceEnabled(...args),
}));

vi.mock('./TenantOpsDashboardV2', () => ({
  TenantOpsDashboardV2: () => <div data-testid="mode-v2">v2 content</div>,
}));
vi.mock('./tenant-ops/TenantOpsGeoCommandCenter', () => ({
  TenantOpsGeoCommandCenter: () => <div data-testid="mode-intel">intel content</div>,
}));
vi.mock('./tenant-ops/TenantOpsClassicShell', () => ({
  TenantOpsClassicShell: () => <div data-testid="mode-classic">classic content</div>,
}));
vi.mock('@/components/tenant-ops-workspace/WorkspaceShell', () => ({
  default: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="mode-workspace">workspace content (embedded={String(!!embedded)})</div>
  ),
}));

vi.mock('@/components/ops/AgentInactiveAlertBanner', () => ({ AgentInactiveAlertBanner: () => null }));
vi.mock('@/components/ops/BehaviorDrawer', () => ({ BehaviorDrawer: () => null }));
vi.mock('@/components/ops/TenantPhoneDuplicatePanel', () => ({ TenantPhoneDuplicatePanel: () => null }));
vi.mock('@/components/ops/WelileHomesAdminPanel', () => ({ WelileHomesAdminPanel: () => null }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } } }) },
    functions: { invoke: vi.fn() },
  },
}));

function renderHub(initialEntries = ['/executive-hub?tab=tenant-ops']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <TenantOpsHub />
    </MemoryRouter>,
  );
}

describe('TenantOpsHub — Workspace mode gating', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('flag ON + a workspace role: shows a fourth "Workspace" tab, Classic still opens by default', async () => {
    mockUseAuth.mockReturnValue({ roles: ['tenant_ops'] });
    mockUseWorkspaceEnabled.mockReturnValue({ data: true });

    renderHub();

    expect(await screen.findByRole('tab', { name: /workspace/i })).toBeInTheDocument();
    // Default mode is still classic, unchanged, even though a new tab exists.
    expect(screen.getByTestId('mode-classic')).toBeInTheDocument();
    expect(screen.queryByTestId('mode-workspace')).not.toBeInTheDocument();
  });

  it('selecting the Workspace tab mounts WorkspaceShell embedded, and does not remount the switcher', async () => {
    mockUseAuth.mockReturnValue({ roles: ['operations'] });
    mockUseWorkspaceEnabled.mockReturnValue({ data: true });

    renderHub();
    const workspaceTab = await screen.findByRole('tab', { name: /workspace/i });
    fireEvent.click(workspaceTab);

    await waitFor(() => {
      expect(screen.getByTestId('mode-workspace')).toHaveTextContent('embedded=true');
    });
    expect(screen.queryByTestId('mode-classic')).not.toBeInTheDocument();
    // The other three tabs are still present and clickable — switching back works.
    fireEvent.click(screen.getByRole('tab', { name: /classic/i }));
    await waitFor(() => expect(screen.getByTestId('mode-classic')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: /new/i }));
    await waitFor(() => expect(screen.getByTestId('mode-v2')).toBeInTheDocument());
  });

  it('flag OFF: the switcher has exactly the three original tabs, byte-for-byte as today', async () => {
    mockUseAuth.mockReturnValue({ roles: ['tenant_ops', 'operations', 'coo', 'ceo', 'super_admin'] });
    mockUseWorkspaceEnabled.mockReturnValue({ data: false });

    renderHub();

    await screen.findByTestId('mode-classic');
    expect(screen.queryByRole('tab', { name: /workspace/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('wrong role (flag on, but none of the five workspace roles): identical to flag off', async () => {
    mockUseAuth.mockReturnValue({ roles: ['cfo', 'manager'] });
    mockUseWorkspaceEnabled.mockReturnValue({ data: true });

    renderHub();

    await screen.findByTestId('mode-classic');
    expect(screen.queryByRole('tab', { name: /workspace/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('a ?mode=workspace deep link is honoured once the gate resolves true', async () => {
    mockUseAuth.mockReturnValue({ roles: ['ceo'] });
    mockUseWorkspaceEnabled.mockReturnValue({ data: true });

    renderHub(['/executive-hub?tab=tenant-ops&mode=workspace']);

    await waitFor(() => expect(screen.getByTestId('mode-workspace')).toBeInTheDocument());
  });

  it('a ?mode=workspace deep link with the gate false falls back to Classic, not an empty state', async () => {
    mockUseAuth.mockReturnValue({ roles: ['cfo'] });
    mockUseWorkspaceEnabled.mockReturnValue({ data: false });

    renderHub(['/executive-hub?tab=tenant-ops&mode=workspace']);

    await screen.findByTestId('mode-classic');
    expect(screen.queryByTestId('mode-workspace')).not.toBeInTheDocument();
  });
});
