import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * Guards the second-level sidebar items added for CRM → Call Center.
 *
 * `ExecutiveDashboardLayout` backs every executive dashboard, so the nesting
 * change has to be strictly additive: a role whose config has no children must
 * render exactly as it did before.
 */

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'staff@welile.com' },
    roles: ['crm', 'coo'],
    signOut: vi.fn(),
    switchRole: vi.fn(),
    addRole: vi.fn(),
  }),
}));

vi.mock('@/hooks/useStaffPermissions', () => ({
  useStaffPermissions: () => ({ hasPermission: () => true }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    rpc: () => Promise.resolve({ data: [], error: null }),
  },
}));

// Chrome that is irrelevant to sidebar nesting.
vi.mock('@/components/RoleSwitcher', () => ({ default: () => <div /> }));
vi.mock('@/components/shared/GlossaryButton', () => ({ GlossaryButton: () => <div /> }));
vi.mock('@/components/budget/BudgetDepartmentNotificationBell', () => ({
  BudgetDepartmentNotificationBell: () => <div />,
}));
vi.mock('@/components/mission/MissionBanner', () => ({ MissionBanner: () => <div /> }));
vi.mock('@/hr/components/MyWork', () => ({ default: () => <div /> }));

// Imported after the mocks are registered.
const { default: ExecutiveDashboardLayout } = await import('./ExecutiveDashboardLayout');

function renderLayout(role: string, activeTab = 'overview', onTabChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ExecutiveDashboardLayout role={role} activeTab={activeTab} onTabChange={onTabChange}>
          <div>panel</div>
        </ExecutiveDashboardLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, onTabChange };
}

/** The desktop sidebar and the mobile drawer both render the nav, so scope
 *  queries to the first match rather than asserting a single node. */
const parentToggle = () => screen.getAllByRole('button', { name: 'Call Center' })[0];
const childButton = (name: string) => screen.queryAllByRole('button', { name })[0];

describe('ExecutiveDashboardLayout — nested sidebar items', () => {
  it('renders a parent with children as a collapsed expander', () => {
    renderLayout('crm');

    const toggle = parentToggle();
    expect(toggle).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Children stay hidden until the parent is opened.
    expect(childButton('History')).toBeUndefined();
  });

  it('reveals the children when the parent is clicked', () => {
    renderLayout('crm');
    fireEvent.click(parentToggle());

    expect(parentToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(childButton('History')).toBeInTheDocument();
    expect(childButton('People / Calls')).toBeInTheDocument();
  });

  it('switches the tab to the child id, not the parent id', () => {
    const onTabChange = vi.fn();
    renderLayout('crm', 'overview', onTabChange);

    fireEvent.click(parentToggle());
    // Opening the parent is a disclosure — it must not change the view.
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.click(childButton('People / Calls'));
    expect(onTabChange).toHaveBeenCalledWith('call-centre-people');
  });

  it('auto-opens the parent when one of its children is the active tab', () => {
    renderLayout('crm', 'call-centre-history');
    // A refresh or deep link must not hide the current view behind a chevron.
    expect(parentToggle()).toHaveAttribute('aria-expanded', 'true');
    expect(childButton('History')).toBeInTheDocument();
  });

  it('finds a child by name in the menu filter and reveals its parent', () => {
    renderLayout('crm');
    const search = screen.getAllByPlaceholderText('Search menu…')[0];

    fireEvent.change(search, { target: { value: 'people' } });

    expect(childButton('People / Calls')).toBeInTheDocument();
    // A match must never be reported as "no menu items match".
    expect(screen.queryByText(/No menu items match/i)).not.toBeInTheDocument();
  });

  it('still reports no matches for a genuinely absent term', () => {
    renderLayout('crm');
    const search = screen.getAllByPlaceholderText('Search menu…')[0];

    fireEvent.change(search, { target: { value: 'zzzznope' } });

    expect(screen.getAllByText(/No menu items match/i).length).toBeGreaterThan(0);
  });

  it('leaves a dashboard with no nested items unchanged', () => {
    const onTabChange = vi.fn();
    renderLayout('coo', 'overview', onTabChange);

    // No expander appears where the config declares no children.
    expect(screen.queryAllByRole('button', { name: 'Call Center' })).toHaveLength(0);

    // Plain items still switch the tab directly on one click.
    const requisitions = screen.queryAllByRole('button', { name: 'Requisitions' })[0];
    expect(requisitions).toBeInTheDocument();
    fireEvent.click(requisitions);
    expect(onTabChange).toHaveBeenCalledWith('requisitions');
  });
});
