import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

// The chat surface needs the full auth provider and a live client; the hello
// bubble under test lives in AgentAssistant alone, so stub the surface out.
vi.mock('@/components/ai-chat/AssistantChatSurface', () => ({ AssistantChatSurface: () => null }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) },
}));

import { AgentAssistant } from '@/components/agent/AgentAssistant';
import { AuthContext } from '@/hooks/useAuth';

const BUBBLE = '[role="status"]';

function renderAssistant(fullName: string) {
  return render(
    <MemoryRouter initialEntries={['/dashboard/funder-preview']}>
      <AuthContext.Provider value={{ user: { user_metadata: { full_name: fullName }, email: 'someone@welile.com' } } as never}>
        <AgentAssistant />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('assistant hello bubble', () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    document.body.innerHTML = '';
  });

  it('greets the person by first name when the page loads', () => {
    renderAssistant('Angwen Sarah');
    const bubble = document.body.querySelector(BUBBLE);
    expect(bubble?.textContent).toContain('Hi 👋 Angwen');
    expect(bubble?.textContent).toContain('need help?');
  });

  it('is still up just before 20 seconds and gone once the fade has run', () => {
    vi.useFakeTimers();
    renderAssistant('Angwen Sarah');
    act(() => { vi.advanceTimersByTime(19_000); });
    expect(document.body.querySelector(BUBBLE)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(document.body.querySelector(BUBBLE)).toBeNull();
  });

  it('opens the chat and never comes back once tapped', () => {
    renderAssistant('Angwen Sarah');
    const bubble = document.body.querySelector(BUBBLE);
    expect(bubble).not.toBeNull();
    fireEvent.click(bubble!.querySelector('button')!);
    expect(document.body.querySelector(BUBBLE)).toBeNull();
  });
});
