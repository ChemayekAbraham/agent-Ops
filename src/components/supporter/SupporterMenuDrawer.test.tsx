import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SupporterMenuDrawer } from './SupporterMenuDrawer';

const navigate = vi.fn();

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

vi.mock('@/lib/haptics', () => ({
  hapticTap: vi.fn(),
  hapticSuccess: vi.fn(),
}));

vi.mock('@/components/supporter/CreditRequestsFeed', () => ({
  CreditRequestsFeed: () => <div data-testid="credit-requests-feed" />,
}));

vi.mock('@/components/supporter/RentCategoryFeed', () => ({
  RentCategoryFeed: () => <div data-testid="rent-category-feed" />,
}));

const routeDestinations = [
  ['Referrals', '/referrals'],
  ['Share App', '/install'],
  ['Returns Analytics', '/supporter-earnings'],
  ['Reinvestment History', '/reinvestment-history'],
  ['History', '/transactions'],
  ['Statement', '/financial-statement'],
  ['Receipts', '/my-receipts'],
  ['Marketplace', '/marketplace'],
  ['Your Profile', '/your-profile'],
  ['Notifications', '/notifications'],
  ['Angel Pool Agreement', '/angel-pool-agreement'],
  ["We're Hiring", '/careers'],
  ['Settings', '/settings'],
  ['Help', '/settings'],
] as const;

const callbackLabels = [
  ['Houses with ready tenants', 'onShowDirectSupport'],
  ['Houses without tenants', 'onShowVacantHouses'],
  ['Welile-managed support', 'onShowManagedSupport'],
  ['Support Tenant', 'onAddInvestment'],
  ['My Portfolios', 'onOpenPortfolios'],
  ['Houses I Support', 'onShowSupportedHouses'],
  ['Angel Pool', 'onShowAngelPool'],
  ['Returns Calculator', 'onOpenCalculator'],
  ['My Wallet', 'onOpenWallet'],
  ['Agreement', 'onViewAgreement'],
  ['Sign Out', 'onSignOut'],
] as const;

function renderMenu() {
  const callbacks = {
    onOpenChange: vi.fn(),
    onAddInvestment: vi.fn(),
    onOpenCalculator: vi.fn(),
    onViewAgreement: vi.fn(),
    onOpenWallet: vi.fn(),
    onOpenPortfolios: vi.fn(),
    onShowDirectSupport: vi.fn(),
    onShowVacantHouses: vi.fn(),
    onShowManagedSupport: vi.fn(),
    onShowAngelPool: vi.fn(),
    onShowSupportedHouses: vi.fn(),
    onSignOut: vi.fn(),
  };

  render(<SupporterMenuDrawer open {...callbacks} />);
  return callbacks;
}

function getMenuButton(label: string) {
  const button = screen.getByText(label, { selector: 'p', exact: true }).closest('button');
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}

describe('SupporterMenuDrawer regression coverage', () => {
  beforeEach(() => {
    navigate.mockReset();
  });

  it('keeps every Funder dashboard action available in the top-right menu', () => {
    renderMenu();

    for (const [label] of [...routeDestinations, ...callbackLabels]) {
      expect(getMenuButton(label)).toBeInTheDocument();
    }
  });

  it('exposes a named modal and controls to screen readers', () => {
    renderMenu();

    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByRole('button', { name: 'Close menu' })).toBeInTheDocument();
  });

  it('keeps keyboard focus inside the menu and closes with Escape', async () => {
    const user = userEvent.setup();
    const callbacks = renderMenu();
    const dialog = screen.getByRole('dialog', { name: 'Menu' });

    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    await user.tab();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard('{Escape}');

    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('uses a viewport-safe mobile width and full-height scrolling region', () => {
    renderMenu();

    const dialog = screen.getByRole('dialog', { name: 'Menu' });
    expect(dialog).toHaveClass('w-[82%]', 'max-w-xs', 'overflow-hidden');
    expect(dialog.querySelector('.overflow-y-auto')).toBeInTheDocument();
  });

  it.each(routeDestinations)('opens %s at %s', (label, destination) => {
    const callbacks = renderMenu();

    fireEvent.click(getMenuButton(label));

    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(destination);
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
  });

  it.each(callbackLabels)('opens %s through its existing dashboard action', (label, callbackName) => {
    const callbacks = renderMenu();

    fireEvent.click(getMenuButton(label));

    expect(callbacks[callbackName]).toHaveBeenCalledOnce();
    expect(callbacks.onOpenChange).toHaveBeenCalledWith(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});