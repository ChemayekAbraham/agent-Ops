import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BottomRoleSwitcher from '@/components/BottomRoleSwitcher';
import RoleSwitcher from '@/components/RoleSwitcher';

// --- Mocks --------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>(
    'react-router-dom'
  );
  return { ...actual, useNavigate: () => mockNavigate };
});

// Default: a supporter-only user
const mockAuth = {
  user: { id: 'user-1' } as any,
  roles: ['supporter'] as string[],
};
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockAuth,
}));

vi.mock('@/hooks/useDeployedCapital', () => ({
  useDeployedCapital: () => ({ isQualifiedInvestor: false }),
}));

const hasAppliedMock = vi.fn().mockReturnValue(false);
const requestRoleMock = vi.fn().mockResolvedValue({ error: null });
vi.mock('@/hooks/useRoleAccessRequests', () => ({
  useRoleAccessRequests: () => ({
    hasApplied: hasAppliedMock,
    requestRole: requestRoleMock,
  }),
}));

vi.mock('@/hooks/useAppPreferences', () => ({
  areAllRolesUnlocked: () => false,
  getPreferredDefaultRole: () => 'auto',
}));

// Capture ApplyForRoleDialog open state
const applyDialogState = { open: false, role: null as string | null };
vi.mock('@/components/ApplyForRoleDialog', () => ({
  default: ({ open, role }: { open: boolean; role: string | null }) => {
    applyDialogState.open = open;
    applyDialogState.role = role;
    return open ? (
      <div role="dialog" data-testid="apply-dialog" data-role={role || ''}>
        Apply for {role}
      </div>
    ) : null;
  },
}));

const renderWithRouter = (ui: React.ReactElement) =>
  render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  mockNavigate.mockReset();
  hasAppliedMock.mockReset().mockReturnValue(false);
  requestRoleMock.mockReset().mockResolvedValue({ error: null });
  mockAuth.roles = ['supporter'];
  applyDialogState.open = false;
  applyDialogState.role = null;
});

// ------------------------------------------------------------------------
// BottomRoleSwitcher
// ------------------------------------------------------------------------

describe('BottomRoleSwitcher — supporter-only user', () => {
  it('does NOT call onRoleChange when tapping unowned Agent role', () => {
    const onRoleChange = vi.fn();
    renderWithRouter(
      <BottomRoleSwitcher currentRole="supporter" onRoleChange={onRoleChange} />
    );
    fireEvent.click(screen.getByText('Agent'));
    expect(onRoleChange).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('opens the Apply dialog when tapping unowned Tenant role', () => {
    const onRoleChange = vi.fn();
    renderWithRouter(
      <BottomRoleSwitcher currentRole="supporter" onRoleChange={onRoleChange} />
    );
    fireEvent.click(screen.getByText('Tenant'));
    expect(onRoleChange).not.toHaveBeenCalled();
    const dialog = screen.getByTestId('apply-dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.getAttribute('data-role')).toBe('tenant');
  });

  it('does NOT open Apply dialog or switch when tapping the active Funder tab', () => {
    const onRoleChange = vi.fn();
    renderWithRouter(
      <BottomRoleSwitcher currentRole="supporter" onRoleChange={onRoleChange} />
    );
    fireEvent.click(screen.getByText('Funder'));
    expect(onRoleChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId('apply-dialog')).not.toBeInTheDocument();
  });

  it('shows "Pending" label when an application already exists', () => {
    hasAppliedMock.mockImplementation((r: string) => r === 'agent');
    const onRoleChange = vi.fn();
    renderWithRouter(
      <BottomRoleSwitcher currentRole="supporter" onRoleChange={onRoleChange} />
    );
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });
});

describe('BottomRoleSwitcher — multi-role user', () => {
  it('switches when tapping a role the user actually owns', () => {
    mockAuth.roles = ['supporter', 'agent'];
    const onRoleChange = vi.fn();
    renderWithRouter(
      <BottomRoleSwitcher currentRole="supporter" onRoleChange={onRoleChange} />
    );
    fireEvent.click(screen.getByText('Agent'));
    expect(onRoleChange).toHaveBeenCalledWith('agent');
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agent');
  });
});

// ------------------------------------------------------------------------
// RoleSwitcher (prominent variant — full-width pills)
// ------------------------------------------------------------------------

describe('RoleSwitcher (prominent) — supporter-only user', () => {
  it('does NOT call onRoleChange or onAddRole when clicking unowned Agent', () => {
    const onRoleChange = vi.fn();
    const onAddRole = vi.fn().mockResolvedValue({ error: null });
    renderWithRouter(
      <RoleSwitcher
        currentRole="supporter"
        availableRoles={['supporter']}
        onRoleChange={onRoleChange}
        onAddRole={onAddRole}
        variant="prominent"
      />
    );
    fireEvent.click(screen.getByText('Agent'));
    expect(onRoleChange).not.toHaveBeenCalled();
    expect(onAddRole).not.toHaveBeenCalled();
  });

  it('opens Apply dialog with correct role when clicking unowned Tenant', () => {
    const onRoleChange = vi.fn();
    renderWithRouter(
      <RoleSwitcher
        currentRole="supporter"
        availableRoles={['supporter']}
        onRoleChange={onRoleChange}
        variant="prominent"
      />
    );
    fireEvent.click(screen.getByText('Tenant'));
    const dialog = screen.getByTestId('apply-dialog');
    expect(dialog.getAttribute('data-role')).toBe('tenant');
  });

  it('opens Apply dialog when clicking unowned Landlord', () => {
    const onRoleChange = vi.fn();
    renderWithRouter(
      <RoleSwitcher
        currentRole="supporter"
        availableRoles={['supporter']}
        onRoleChange={onRoleChange}
        variant="prominent"
      />
    );
    fireEvent.click(screen.getByText('Landlord'));
    const dialog = screen.getByTestId('apply-dialog');
    expect(dialog.getAttribute('data-role')).toBe('landlord');
  });

  it('does not open Apply dialog when role is already owned', () => {
    mockAuth.roles = ['supporter', 'tenant'];
    const onRoleChange = vi.fn();
    renderWithRouter(
      <RoleSwitcher
        currentRole="supporter"
        availableRoles={['supporter', 'tenant']}
        onRoleChange={onRoleChange}
        variant="prominent"
      />
    );
    fireEvent.click(screen.getByText('Tenant'));
    expect(onRoleChange).toHaveBeenCalledWith('tenant');
    expect(screen.queryByTestId('apply-dialog')).not.toBeInTheDocument();
  });
});