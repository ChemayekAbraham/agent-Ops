/**
 * Funder onboarding (step 4) — split name capture + unchanged step gating.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';

class IO {
  observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}
(globalThis as any).IntersectionObserver = IO;


// AnimatePresence mode="wait" never finishes exit animations in jsdom, so the
// next step would never mount. Render motion elements as plain DOM instead.
vi.mock('framer-motion', () => {
  const React = require('react');
  const strip = (props: any) => {
    const {
      initial, animate, exit, transition, variants, whileHover, whileTap, whileInView,
      viewport, layout, layoutId, drag, dragConstraints, onAnimationComplete, custom,
      ...rest
    } = props || {};
    return rest;
  };
  const make = (tag: string) =>
    React.forwardRef((props: any, ref: any) => React.createElement(tag, { ...strip(props), ref }, props?.children));
  const motion: any = new Proxy({}, { get: (_t, tag: string) => make(tag) });
  return {
    motion,
    AnimatePresence: ({ children }: any) => React.createElement(React.Fragment, null, children),
    useReducedMotion: () => false,
    useInView: () => true,
    useAnimation: () => ({ start: vi.fn(), stop: vi.fn(), set: vi.fn() }),
    useMotionValue: (v: any) => ({ get: () => v, set: vi.fn(), on: () => () => {} }),
    useTransform: () => ({ get: () => 0, set: vi.fn(), on: () => () => {} }),
    useSpring: (v: any) => ({ get: () => v, set: vi.fn(), on: () => () => {} }),
    animate: vi.fn(),
  };
});

const invokeSpy = vi.fn().mockResolvedValue({ data: { userId: 'u9' }, error: null });
const toastError = vi.fn();

const AUTH = { user: null, loading: false };
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => AUTH }));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: toastError, info: vi.fn() },
  Toaster: () => null,
}));
vi.mock('@/lib/signupGuard', () => ({
  preflightSignup: vi.fn().mockResolvedValue({ allowed: true, attempt_id: 'a1' }),
  attachSignupUser: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/components/partner/renderAgreementPdf', () => ({
  renderAgreementPdfBase64: vi.fn().mockResolvedValue(null),
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    functions: { invoke: (...a: any[]) => invokeSpy(...a) },
    auth: { signInWithPassword: async () => ({ data: { user: { id: 'u9' }, session: {} }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      insert: () => Promise.resolve({ error: null }),
      upsert: async () => ({ error: null }),
    }),
  },
}));

async function renderOnboarding() {
  const Onboarding = (await import('@/pages/Onboarding')).default;
  return render(
    <HelmetProvider>
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>
    </HelmetProvider>,
  );
}

const clickContinue = () => fireEvent.click(screen.getByRole('button', { name: /Continue|Create Account/i }));
const onStep = (n: number) => screen.queryByText(new RegExp(`Step ${n} / 4`, 'i')) !== null;

/** Walks the wizard to step 4 with valid values for steps 1-3. */
async function goToStep4() {
  // Step 1 — tick the acknowledgement checkbox.
  const ack = screen.getByText(/Welile manages tenant relationships/i);
  const checkbox = ack.parentElement!.querySelector('div[class*="rounded"]') as HTMLElement;
  fireEvent.click(checkbox);
  clickContinue();
  await waitFor(() => expect(onStep(2)).toBe(true));

  // Step 2 — choose a path and enter an amount.
  fireEvent.click(screen.getByText(/Support a Tenant/i));
  const amount = await waitFor(() => screen.getByPlaceholderText(/Enter amount/i));
  fireEvent.change(amount, { target: { value: '1,000,000' } });
  clickContinue();
  await waitFor(() => expect(onStep(3)).toBe(true));

  // Step 3 — bank payout
  // + next of kin
  if (!screen.queryByPlaceholderText(/e.g. Stanbic Bank/i)) {
    fireEvent.click(screen.getAllByText(/^Bank$/i)[0]);
    await waitFor(() => expect(screen.getByPlaceholderText(/e.g. Stanbic Bank/i)).toBeInTheDocument());
  }
  fireEvent.change(screen.getByPlaceholderText(/e.g. Stanbic Bank/i), { target: { value: 'Stanbic Bank' } });
  fireEvent.change(screen.getByPlaceholderText(/Name on the account/i), { target: { value: 'Alice Nakato' } });
  fireEvent.change(screen.getByPlaceholderText(/^Account number$/i), { target: { value: '123456789' } });
  fireEvent.change(screen.getByPlaceholderText(/^Full name$/i), { target: { value: 'Grace Nakato' } });
  fireEvent.change(screen.getByPlaceholderText(/\+256 700 000 000/i), { target: { value: '+256771234567' } });
  clickContinue();
  await waitFor(() => expect(onStep(4)).toBe(true));
}

beforeEach(() => { invokeSpy.mockClear(); toastError.mockClear(); });

describe('Onboarding — split name capture', () => {
  it('still blocks step 1 until the confirmation box is ticked', async () => {
    await renderOnboarding();
    clickContinue();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(onStep(1)).toBe(true);
  });

  it('renders the three split name fields on step 4 and blocks advance without a last name', async () => {
    await renderOnboarding();
    await goToStep4();

    expect(screen.getByLabelText(/First name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Other names/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Last name/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/First name/i), { target: { value: 'Timothy' } });
    fireEvent.change(screen.getByLabelText(/Other names/i), { target: { value: 'Christian' } });
    toastError.mockClear();
    clickContinue();
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(invokeSpy).not.toHaveBeenCalled();
  });
});
