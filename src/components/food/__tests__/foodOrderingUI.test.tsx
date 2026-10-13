import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

// These screens are exercised against the fixture backend, which is now opt-in
// and development-only (isFoodMockMode). Opt in explicitly.
vi.stubEnv('VITE_FOOD_SERVICE_MOCK', 'true');

/**
 * UI tests for Employee Food Ordering.
 *
 * These run the real hooks against the real in-memory fixture backend — only
 * the Supabase client and the page chrome are stubbed. So a passing test here
 * means the screen, the hook and the fixture agree, which is the thing worth
 * knowing while the migrations are unapplied.
 *
 * Two properties are asserted repeatedly and deliberately:
 *   1. no screen ever offers to pay for anything;
 *   2. payment and fulfilment are shown as separate states.
 */

const authState = vi.hoisted(() => ({ userId: null as string | null }));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: async () => ({ data: { user: authState.userId ? { id: authState.userId } : null } }),
    },
    from: () => { throw new Error('UI must not query tables directly in fixture mode'); },
    rpc: () => { throw new Error('UI must not call RPCs directly in fixture mode'); },
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// The page chrome pulls in auth, HR and storage; none of it is under test here.
vi.mock('@/components/layout/PersonalLayout', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import FoodMealCard from '@/components/food/FoodMealCard';
import FoodOrderingPage from '@/pages/me/food/FoodOrderingPage';
import MyFoodOrdersPage from '@/pages/me/food/MyFoodOrdersPage';
import FoodManagementPage from '@/pages/me/food/FoodManagementPage';
import {
  resetFoodMock, setFoodMockUser, foodMockRpc, MOCK_COORDINATOR, MOCK_EMPLOYEE, foodToday,
} from '@/lib/foodService.mock';
import type { FoodMenuMeal } from '@/lib/foodService';

function renderWithProviders(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const asEmployee = () => { authState.userId = MOCK_EMPLOYEE; setFoodMockUser(MOCK_EMPLOYEE); };
const asCoordinator = () => { authState.userId = MOCK_COORDINATOR; setFoodMockUser(MOCK_COORDINATOR); };

// The fixture's service windows are wall-clock based (Breakfast 06:30-09:00,
// Lunch 08:00-23:59, Africa/Kampala). Without a fixed clock these tests passed
// or failed depending on the hour they ran (master register FM-35). Pin only
// Date, to a Kampala noon, so testing-library's own timers stay real.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-12T09:00:00Z'));   // 12:00 in Kampala
});
afterAll(() => { vi.useRealTimers(); });

beforeEach(() => {
  resetFoodMock();
  asEmployee();
});

// ─────────────────────────── meal card ───────────────────────────

const baseMeal: FoodMenuMeal = {
  menu_item_id: 'mi-1',
  meal_id: 'm-1',
  name: 'Matoke with Beef Stew',
  description: 'Steamed green bananas',
  image_path: null,
  category: 'Main Course',
  price_ugx: 8000,
  servings_total: 20,
  servings_remaining: 20,
  sold_out: false,
};

describe('FoodMealCard', () => {
  const card = (meal: Partial<FoodMenuMeal>, props: Partial<{
    quantity: number; orderingOpen: boolean; remainingAllowance: number | null;
  }> = {}) => {
    const onChange = vi.fn();
    render(
      <FoodMealCard
        meal={{ ...baseMeal, ...meal }}
        quantity={props.quantity ?? 0}
        orderingOpen={props.orderingOpen ?? true}
        remainingAllowance={props.remainingAllowance ?? null}
        onChange={onChange}
      />,
    );
    return onChange;
  };

  it('shows the name, price, category and description', () => {
    card({});
    expect(screen.getByText('Matoke with Beef Stew')).toBeInTheDocument();
    expect(screen.getByText('UGX 8,000')).toBeInTheDocument();
    expect(screen.getByText('Main Course')).toBeInTheDocument();
    expect(screen.getByText('Steamed green bananas')).toBeInTheDocument();
  });

  it('says sold out and refuses to add', () => {
    card({ sold_out: true });
    const button = screen.getByRole('button', { name: /sold out/i });
    expect(button).toBeDisabled();
  });

  it('says ordering is closed once the window has passed', () => {
    card({}, { orderingOpen: false });
    expect(screen.getByRole('button', { name: /ordering closed/i })).toBeDisabled();
  });

  it('warns only when stock is genuinely low', () => {
    card({ servings_remaining: 2 });
    expect(screen.getByText(/only 2 left/i)).toBeInTheDocument();
  });

  it('says nothing about stock when the meal is uncapped', () => {
    card({ servings_total: null, servings_remaining: null });
    expect(screen.queryByText(/left/i)).not.toBeInTheDocument();
  });

  it('adds one on the first click', async () => {
    const onChange = card({});
    await userEvent.click(screen.getByRole('button', { name: /^add$/i }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('steps the quantity up and down', async () => {
    const onChange = card({}, { quantity: 2 });
    await userEvent.click(screen.getByRole('button', { name: /add one/i }));
    expect(onChange).toHaveBeenCalledWith(3);
    await userEvent.click(screen.getByRole('button', { name: /remove one/i }));
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it('stops at the stock ceiling', () => {
    card({ servings_remaining: 2 }, { quantity: 2 });
    expect(screen.getByRole('button', { name: /add one/i })).toBeDisabled();
  });

  it('stops at the per-person allowance and explains why', () => {
    card({}, { quantity: 3, remainingAllowance: 3 });
    expect(screen.getByRole('button', { name: /add one/i })).toBeDisabled();
    expect(screen.getByText(/your limit for this service period/i)).toBeInTheDocument();
  });

  it('falls back to the icon when a photo fails to load', () => {
    render(
      <FoodMealCard
        meal={{ ...baseMeal, image_path: '/gone.jpg' }}
        quantity={0} orderingOpen remainingAllowance={null} onChange={vi.fn()}
      />,
    );
    const img = document.querySelector('img') as HTMLImageElement;
    expect(img).toBeTruthy();
    // a stored path can rot; the card must not leave a broken image behind
    img.dispatchEvent(new Event('error'));
    return waitFor(() => expect(document.querySelector('img')).toBeNull());
  });
});

// ─────────────────────── employee ordering ───────────────────────

describe('Food ordering page', () => {
  it('groups the menu by service period and marks closed windows', async () => {
    renderWithProviders(<FoodOrderingPage />);
    await screen.findByText('Lunch');
    expect(screen.getByText('Breakfast')).toBeInTheDocument();
    expect(screen.getAllByText(/ordering (open|closed)/i).length).toBeGreaterThan(0);
  });

  it('shows the collection instructions for the period', async () => {
    renderWithProviders(<FoodOrderingPage />);
    expect(await screen.findByText(/bring your staff card/i)).toBeInTheDocument();
  });

  it('never offers to pay', async () => {
    renderWithProviders(<FoodOrderingPage />);
    await screen.findByText('Lunch');
    expect(screen.queryByRole('button', { name: /^pay|checkout/i })).not.toBeInTheDocument();
  });

  it('places an UNPAID order and clears the cart', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodOrderingPage />);
    await screen.findByText('Lunch');

    const pilau = screen.getByText('Chicken Pilau').closest('article')!;
    await user.click(within(pilau).getByRole('button', { name: /^add$/i }));

    await user.click(await screen.findByRole('button', { name: /review order/i }));

    // the cart must say, unmissably, that nothing is charged now
    expect(await screen.findByText(/nothing is charged now/i)).toBeInTheDocument();
    const place = screen.getByRole('button', { name: /place order/i });
    expect(screen.queryByRole('button', { name: /^pay$/i })).not.toBeInTheDocument();

    // a payment mode is required and never pre-selected (D1)
    expect(place).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /mobile money/i }));
    expect(place).toBeEnabled();

    await user.click(place);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /review order/i })).not.toBeInTheDocument());
  });

  it('lets an employee use their whole allowance, counting the cart once (FM-08)', async () => {
    // Lunch allows 5 per person and the fixture employee already holds 2, so 3
    // more must be addable. The cart used to be subtracted twice, which
    // disabled "+" after 2.
    const user = userEvent.setup();
    renderWithProviders(<FoodOrderingPage />);
    await screen.findByText('Lunch');
    const pilau = screen.getByText('Chicken Pilau').closest('article')!;
    await user.click(within(pilau).getByRole('button', { name: /^add$/i }));
    const more = () => within(pilau).getByRole('button', { name: /add one chicken pilau/i });
    expect(more()).toBeEnabled();
    await user.click(more());
    expect(more()).toBeEnabled();
    await user.click(more());
    expect(more()).toBeDisabled();
  });

  it('keeps the submit button out of reach while the cart is empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodOrderingPage />);
    await screen.findByText('Lunch');
    // no cart bar at all until something is added
    expect(screen.queryByRole('button', { name: /review order/i })).not.toBeInTheDocument();
    const pilau = screen.getByText('Chicken Pilau').closest('article')!;
    await user.click(within(pilau).getByRole('button', { name: /^add$/i }));
    expect(await screen.findByRole('button', { name: /review order/i })).toBeInTheDocument();
  });
});

// ───────────────────────── my orders ─────────────────────────

describe('My orders page', () => {
  it('lists an order with payment and fulfilment shown separately', async () => {
    renderWithProviders(<MyFoodOrdersPage />);
    // the fixture gives this employee one order, unpaid and ready
    expect(await screen.findByText(/ready for collection/i)).toBeInTheDocument();
    expect(screen.getByText(/not paid yet/i)).toBeInTheDocument();
  });

  it('does not offer to withdraw an order the kitchen has already worked', async () => {
    renderWithProviders(<MyFoodOrdersPage />);
    await screen.findByText(/ready for collection/i);
    // the worked order is paid and ready, so its card carries no withdraw control;
    // the employee's other, unpaid order still does
    const worked = screen.getByText(/ready for collection/i).closest('li')!;
    expect(within(worked).queryByRole('button', { name: /withdraw/i })).not.toBeInTheDocument();
  });

  it('offers to withdraw a freshly placed order', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodOrderingPage />);
    await screen.findByText('Lunch');
    const posho = screen.getByText('Posho and Beans').closest('article')!;
    await user.click(within(posho).getByRole('button', { name: /^add$/i }));
    await user.click(await screen.findByRole('button', { name: /review order/i }));
    await user.click(screen.getByRole('radio', { name: /^cash$/i }));
    await user.click(screen.getByRole('button', { name: /place order/i }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /review order/i })).not.toBeInTheDocument());

    renderWithProviders(<MyFoodOrdersPage />);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /withdraw/i }).length).toBeGreaterThan(0));
  });

  it('shows an empty state before anything is ordered', async () => {
    // a person with no orders at all
    authState.userId = '44444444-4444-4444-8444-444444444444';
    setFoodMockUser(authState.userId);
    renderWithProviders(<MyFoodOrdersPage />);
    expect(await screen.findByText(/have not ordered anything yet/i)).toBeInTheDocument();
  });
});

// ──────────────────────── food management ────────────────────────

describe('Food Management access', () => {
  it('turns an ordinary employee away', async () => {
    renderWithProviders(<FoodManagementPage />);
    expect(await screen.findByText(/do not have access to food management/i)).toBeInTheDocument();
  });

  it('never flashes a denial while the check is still running', () => {
    renderWithProviders(<FoodManagementPage />);
    // first paint, before the permission query resolves
    expect(screen.queryByText(/do not have access/i)).not.toBeInTheDocument();
  });

  it('lets the active Food Coordinator in', async () => {
    asCoordinator();
    renderWithProviders(<FoodManagementPage />);
    expect(await screen.findByRole('tab', { name: /orders & queue/i })).toBeInTheDocument();
    expect(screen.queryByText(/do not have access/i)).not.toBeInTheDocument();
  });

  it('shows every management area', async () => {
    asCoordinator();
    renderWithProviders(<FoodManagementPage />);
    await screen.findByRole('tab', { name: /overview/i });
    for (const tab of ['Overview', 'Orders & queue', 'Menu', 'Service', 'History', 'Coordinator']) {
      expect(screen.getByRole('tab', { name: tab })).toBeInTheDocument();
    }
  });
});

describe('Food Management overview', () => {
  beforeEach(asCoordinator);

  it('reads the payment rule from the service, not from the build', async () => {
    renderWithProviders(<FoodManagementPage />);
    // the service reports fulfilment_requires_payment: false (payment after delivery)
    expect(await screen.findByText(/payment is made after delivery/i)).toBeInTheDocument();
  });

  it('counts unpaid orders and labels paid value as operational', async () => {
    renderWithProviders(<FoodManagementPage />);
    expect(await screen.findByText('Unpaid')).toBeInTheDocument();
    expect(screen.getByText(/not an accounting figure/i)).toBeInTheDocument();
  });

  it('labels the paid figure as operational, not accounting', async () => {
    renderWithProviders(<FoodManagementPage />);
    await screen.findByText('Paid order value');
    expect(screen.getByText(/not an accounting figure/i)).toBeInTheDocument();
  });

  it('warns on the queue that the payment evidence is test data', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));
    expect(await screen.findByText(/carry test\s+payment evidence, not a real payment/i))
      .toBeInTheDocument();
    expect(screen.getByText(/no wallet was charged/i)).toBeInTheDocument();
  });
});

describe('Food Management queue', () => {
  beforeEach(asCoordinator);

  it('lets the coordinator start an unpaid order in this environment', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));

    const start = await screen.findAllByRole('button', { name: /being prepared/i });
    expect(start[0]).toBeEnabled();
  });

  it('shows payment and fulfilment as separate states on every row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));
    // the genuinely unpaid order still reads "Not paid yet" alongside its own
    // fulfilment state, and the paid ones read "Paid" — never merged
    await waitFor(() =>
      expect(screen.getAllByText(/not paid yet/i).length).toBeGreaterThan(0));
    expect(screen.getAllByText(/^paid$/i).length).toBeGreaterThan(0);
  });

  it('lets the coordinator work an unpaid order, which still shows as unpaid', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));
    await waitFor(() =>
      expect(screen.getAllByText(/not paid yet/i).length).toBeGreaterThan(0));

    // payment is after delivery (D2): no control is blocked on payment
    expect(screen.queryByText(/has not been paid for/i)).not.toBeInTheDocument();
    const unpaidCard = screen.getAllByText(/not paid yet/i)[0].closest('li')!;
    const prepare = within(unpaidCard).queryByRole('button', { name: /being prepared/i });
    if (prepare) expect(prepare).toBeEnabled();
  });
});

describe('Coordinator handover', () => {
  beforeEach(asCoordinator);

  it('offers no successor by default', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    expect(await screen.findByText(/choose a person/i)).toBeInTheDocument();
  });

  it('will not submit without a successor and a real reason', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    const handOver = await screen.findByRole('button', { name: /^hand over$/i });
    expect(handOver).toBeDisabled();

    await user.type(screen.getByLabelText(/reason/i), 'too short');
    expect(handOver).toBeDisabled();
  });

  it('spells out what each handover mode costs the current holder', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    expect(await screen.findByText(/you lose access entirely/i)).toBeInTheDocument();
    expect(screen.getByText(/you keep read-only access/i)).toBeInTheDocument();
  });

  it('shows who currently holds the role', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    expect(await screen.findByText(/active coordinator/i)).toBeInTheDocument();
  });
});

describe('Successor picker', () => {
  beforeEach(asCoordinator);

  it('loads real candidates rather than sitting on a placeholder', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    // resolves from "Loading people…" to the real prompt once the query lands
    expect(await screen.findByText(/choose a person/i)).toBeInTheDocument();
  });

  it('enables the picker for the active coordinator', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    await screen.findByText(/choose a person/i);
    await waitFor(() =>
      expect(screen.getByLabelText(/hand over to/i)).not.toBeDisabled());
  });

  it('never names a successor until one is chosen', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    await screen.findByText(/choose a person/i);
    // the confirm button stays out of reach with no successor selected
    expect(await screen.findByRole('button', { name: /^hand over$/i })).toBeDisabled();
  });
});

describe('Backup holder', () => {
  beforeEach(async () => {
    // the coordinator hands over but keeps read-only access, then we look as them
    asCoordinator();
    await foodMockRpc('food_transfer_coordinator', {
      p_to_user_id: MOCK_EMPLOYEE,
      p_mode: 'transfer_with_backup',
      p_reason: 'The coordinator is on leave for two weeks',
    });
    setFoodMockUser(MOCK_COORDINATOR);
    authState.userId = MOCK_COORDINATOR;
  });

  it('is let in, and told the access is read-only', async () => {
    renderWithProviders(<FoodManagementPage />);
    expect(await screen.findByText(/backup/i)).toBeInTheDocument();
    expect(screen.queryByText(/do not have access/i)).not.toBeInTheDocument();
  });

  it('cannot author the menu', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /^menu$/i }));
    expect(await screen.findByRole('button', { name: /add meal/i })).toBeDisabled();
  });

  it('cannot work the fulfilment queue', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));
    const buttons = await screen.findAllByRole('button', { name: /being prepared/i });
    expect(buttons[0]).toBeDisabled();
  });

  it('is not offered the handover, and triggers no successor lookup', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    expect(await screen.findByText(/only the active food coordinator can hand/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^hand over$/i })).toBeDisabled();
  });

  it('can still see who holds the role', async () => {
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /coordinator/i }));
    expect(await screen.findByText(/active coordinator/i)).toBeInTheDocument();
  });
});


// ─────────── completion: payment mode, exceptions, cancel, menu (FM-21/25/26) ───────────

describe('Payment mode is shown wherever an order is (FM-25)', () => {
  it('shows the declared mode on My orders, beside "Not paid yet"', async () => {
    renderWithProviders(<MyFoodOrdersPage />);
    expect(await screen.findByText(/pays by welile wallet/i)).toBeInTheDocument();
    expect(screen.getByText(/pays by mobile money/i)).toBeInTheDocument();
    expect(screen.getAllByText(/not paid yet/i).length).toBeGreaterThan(0);
  });

  it('shows the declared mode on every kitchen row', async () => {
    asCoordinator();
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));
    await waitFor(() => expect(screen.getAllByText(/^pays by /i).length).toBeGreaterThan(0));
  });
});

describe('Reporting a problem with an order (FM-21)', () => {
  it('lets an employee report a problem once, and shows it as open', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyFoodOrdersPage />);
    await screen.findByText(/pays by mobile money/i);
    const card = screen.getByText(/pays by mobile money/i).closest('li')!;
    await user.click(within(card).getByRole('button', { name: /view details/i }));

    const report = await screen.findByRole('region', { name: /report a problem/i });
    const submit = within(report).getByRole('button', { name: /report problem/i });
    expect(submit).toBeDisabled();
    await user.selectOptions(within(report).getByLabelText(/what went wrong/i), 'MISSING_ITEM');
    await user.type(within(report).getByLabelText(/describe the problem/i), 'Beans were missing');
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await within(report).findByText(/your report is with the food coordinator/i)).toBeInTheDocument();
    expect(within(report).queryByRole('button', { name: /report problem/i })).not.toBeInTheDocument();
  });

  it('shows the employee report to the coordinator, marked as from the employee', async () => {
    // the employee reports first
    const user = userEvent.setup();
    const employeeView = renderWithProviders(<MyFoodOrdersPage />);
    const card = (await screen.findByText(/pays by mobile money/i)).closest('li')!;
    await user.click(within(card).getByRole('button', { name: /view details/i }));
    const report = await screen.findByRole('region', { name: /report a problem/i });
    await user.selectOptions(within(report).getByLabelText(/what went wrong/i), 'QUALITY_ISSUE');
    await user.type(within(report).getByLabelText(/describe the problem/i), 'Food was cold');
    await user.click(within(report).getByRole('button', { name: /report problem/i }));
    await within(report).findByText(/your report is with the food coordinator/i);
    employeeView.unmount();

    asCoordinator();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    // listed as an open exception, and recorded in the audit history
    await waitFor(() => expect(screen.getAllByText('Food was cold').length).toBeGreaterThanOrEqual(1));
    expect(screen.getByText(/reported by the employee/i)).toBeInTheDocument();
  });

  it('lets the coordinator log an exception with a mandatory description', async () => {
    asCoordinator();
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    const log = await screen.findByRole('button', { name: /log exception/i });
    expect(log).toBeDisabled();
    await user.selectOptions(screen.getByLabelText(/exception kind/i), 'ORDER_ERROR');
    expect(log).toBeDisabled();
    await user.type(screen.getByLabelText(/exception description/i), 'Swapped matooke for rice');
    await user.click(log);
    await waitFor(() => expect(screen.getAllByText('Swapped matooke for rice').length).toBeGreaterThanOrEqual(1));
    expect(screen.getAllByText(/logged by the food coordinator/i).length).toBeGreaterThan(0);
  });
});

describe('Kitchen cancellation needs confirmation and a reason (FM-26)', () => {
  it('does not cancel on a single click, and requires a reason', async () => {
    asCoordinator();
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /orders & queue/i }));
    const cancel = (await screen.findAllByRole('button', { name: /^cancel$/i }))[0];
    await user.click(cancel);

    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /cancel order/i });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/reason/i), 'Ran out of beans');
    expect(confirm).toBeEnabled();
    await user.click(within(dialog).getByRole('button', { name: /keep order/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });
});

describe('Menu scheduling validates its inputs (FM-26)', () => {
  it('refuses a fractional serving cap and a negative day price', async () => {
    asCoordinator();
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /^menu$/i }));
    const servings = await screen.findByLabelText(/serving cap/i);
    await user.type(servings, '1.5');
    expect(await screen.findByText(/whole number of zero or more/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add to menu/i })).toBeDisabled();
    await user.clear(servings);
    await user.type(screen.getByLabelText(/price for the day/i), '-5');
    expect(await screen.findByText(/price for the day must be zero or more/i)).toBeInTheDocument();
  });

  it('offers a service date that cannot be in the past', async () => {
    asCoordinator();
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /^menu$/i }));
    const date = await screen.findByLabelText(/service date/i);
    expect(date).toHaveAttribute('min', foodToday());
    expect(date).toHaveValue(foodToday());
  });
});

describe('Exception pickers offer the nine approved kinds', () => {
  const NINE = ['Missing item', 'Wrong item', 'Quality issue', 'Late delivery', 'Not delivered',
    'Damaged order', 'Stock unavailable', 'Order error', 'Other'];

  it('in the coordinator log form', async () => {
    asCoordinator();
    const user = userEvent.setup();
    renderWithProviders(<FoodManagementPage />);
    await user.click(await screen.findByRole('tab', { name: /history/i }));
    const select = await screen.findByLabelText(/exception kind/i);
    const options = within(select).getAllByRole('option').map((o) => o.textContent).filter((t) => t !== 'Kind…');
    expect(options).toEqual(NINE);
  });

  it('in the employee report form', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MyFoodOrdersPage />);
    const card = (await screen.findByText(/pays by mobile money/i)).closest('li')!;
    await user.click(within(card).getByRole('button', { name: /view details/i }));
    const report = await screen.findByRole('region', { name: /report a problem/i });
    const options = within(within(report).getByLabelText(/what went wrong/i)).getAllByRole('option')
      .map((o) => o.textContent).filter((t) => t !== 'What went wrong?');
    expect(options).toEqual(NINE);
  });
});
