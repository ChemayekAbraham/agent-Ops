import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { HelmetProvider } from 'react-helmet-async';

// The chat surface needs the full auth provider and a live client; the launcher
// gate under test lives in the pages themselves, so stub the surface out.
vi.mock('@/components/ai-chat/AssistantChatSurface', () => ({
  AssistantChatSurface: ({ open }: { open: boolean }) => <div data-chat-open={open ? 'yes' : 'no'} />,
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) },
}));

import { AgentAssistant } from '@/components/agent/AgentAssistant';
import WelcomeNew from '@/pages/WelcomeNew';
import { AuthContext } from '@/hooks/useAuth';

const SIGNED_IN = {
  user: { id: 'TEST_USER', user_metadata: { full_name: 'Angwen Sarah' }, email: 'someone@welile.com' },
  session: { access_token: 'TEST_TOKEN' },
  loading: false,
  roles: [],
} as never;

const SIGNED_OUT = { user: null, session: null, loading: false, roles: [] } as never;

function welcomeTree(value: never) {
  return (
    <HelmetProvider>
      <MemoryRouter initialEntries={['/welcome?step=2']}>
        <AuthContext.Provider value={value}>
          <WelcomeNew />
        </AuthContext.Provider>
      </MemoryRouter>
    </HelmetProvider>
  );
}

function assistantTree(value: never) {
  return (
    <MemoryRouter initialEntries={['/dashboard/agent']}>
      <AuthContext.Provider value={value}>
        <AgentAssistant />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

describe('assistant launcher on pages with no active session', () => {
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('hides the welcome page launcher for a visitor with no session', () => {
    render(welcomeTree(SIGNED_OUT));
    expect(screenQuery('Welile AI')).toBeNull();
  });

  it('shows the welcome page launcher once a session is active', () => {
    render(welcomeTree(SIGNED_IN));
    expect(screenQuery('Welile AI')).not.toBeNull();
  });

  it('refuses to open the chat from a page with no session', () => {
    render(assistantTree(SIGNED_OUT));
    act(() => { window.dispatchEvent(new CustomEvent('open-welile-assistant')); });
    expect(document.body.querySelector('[data-chat-open]')?.getAttribute('data-chat-open')).toBe('no');
  });

  it('opens the chat from the same event for a signed-in person', () => {
    render(assistantTree(SIGNED_IN));
    act(() => { window.dispatchEvent(new CustomEvent('open-welile-assistant')); });
    expect(document.body.querySelector('[data-chat-open]')?.getAttribute('data-chat-open')).toBe('yes');
  });
});

function screenQuery(label: string) {
  return Array.from(document.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === label,
  ) ?? null;
}
