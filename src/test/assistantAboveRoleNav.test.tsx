import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// The chat surface needs the full auth provider and a live client; only its
// stacking level matters here, so stub the surface out.
vi.mock('@/components/ai-chat/AssistantChatSurface', () => ({ AssistantChatSurface: () => null }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});

// Keep the real AuthContext (AgentAssistant reads it with useContext) and give
// BottomRoleSwitcher the session-shaped object its useAuth() hook expects.
vi.mock('@/hooks/useAuth', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useAuth')>('@/hooks/useAuth');
  return {
    ...actual,
    useAuth: () => ({ user: { id: 'user-1' }, roles: ['agent'], rolesResolved: true }),
  };
});

vi.mock('@/hooks/useDeployedCapital', () => ({
  useDeployedCapital: () => ({ isQualifiedInvestor: false }),
}));
vi.mock('@/hooks/useRoleAccessRequests', () => ({
  useRoleAccessRequests: () => ({ hasApplied: () => false, requestRole: vi.fn() }),
}));
vi.mock('@/hooks/useAppPreferences', () => ({
  areAllRolesUnlocked: () => false,
  getPreferredDefaultRole: () => 'auto',
}));
vi.mock('@/components/ApplyForRoleDialog', () => ({ default: () => null }));

import BottomRoleSwitcher from '@/components/BottomRoleSwitcher';
import { AgentAssistant } from '@/components/agent/AgentAssistant';
import { AuthContext } from '@/hooks/useAuth';
import { FLOATING_NAV_Z } from '@/components/ui/floating-nav';

/** The chat sheet's backdrop level (`z-[110]` on SheetOverlay). */
const CHAT_BACKDROP_Z = 110;

const zIndexOf = (el: Element | null) => {
  const raw = el ? window.getComputedStyle(el).zIndex : '';
  const value = Number(raw);
  expect(raw, 'element must carry a numeric z-index').not.toBe('');
  expect(Number.isNaN(value)).toBe(false);
  return value;
};

function renderBoth() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/agent']}>
      <AuthContext.Provider
        value={{ user: { user_metadata: { full_name: 'Angwen Sarah' }, email: 'someone@welile.com' } } as never}
      >
        <BottomRoleSwitcher currentRole={'agent' as never} onRoleChange={vi.fn()} />
        <AgentAssistant />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('bottom role nav vs. the Welile Assistant', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('keeps the nav behind the assistant launcher', () => {
    renderBoth();
    const nav = document.body.querySelector('nav[aria-label="Switch dashboard role"]');
    const launcher = document.body.querySelector('button[aria-label="Chat with Welile Assistant"]');
    expect(nav).not.toBeNull();
    expect(launcher).not.toBeNull();
    expect(zIndexOf(nav)).toBe(FLOATING_NAV_Z);
    expect(zIndexOf(launcher)).toBeGreaterThan(zIndexOf(nav));
  });

  it('keeps the hello bubble in front of the nav too', () => {
    renderBoth();
    const nav = document.body.querySelector('nav[aria-label="Switch dashboard role"]');
    // The nav announces role changes through its own role="status" live region,
    // so the bubble is the one that is positioned fixed.
    const bubble = Array.from(document.body.querySelectorAll('[role="status"]')).find((el) =>
      el.classList.contains('fixed'),
    );
    expect(bubble).toBeDefined();
    expect(zIndexOf(bubble ?? null)).toBeGreaterThan(zIndexOf(nav));
  });

  it('leaves the launcher below the open chat sheet', () => {
    renderBoth();
    const launcher = document.body.querySelector('button[aria-label="Chat with Welile Assistant"]');
    expect(zIndexOf(launcher)).toBeLessThan(CHAT_BACKDROP_Z);
  });
});
