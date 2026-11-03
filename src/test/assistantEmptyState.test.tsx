import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const state = vi.hoisted(() => ({
  messages: [] as { id: string; role: 'user' | 'assistant'; content: string }[],
  send: vi.fn(),
}));

vi.mock('@/hooks/useAgentAssistant', () => ({
  useAgentAssistant: () => ({
    messages: state.messages,
    isLoading: false,
    send: state.send,
    stop: vi.fn(),
    escalate: vi.fn(),
    escalated: false,
  }),
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { user_metadata: { full_name: 'Ssenkaali Kato' } }, role: 'agent' }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) },
}));

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));

import { AssistantChatSurface } from '@/components/ai-chat/AssistantChatSurface';

function open() {
  return render(
    <MemoryRouter initialEntries={['/dashboard/agent']}>
      <AssistantChatSurface open onOpenChange={() => {}} />
    </MemoryRouter>,
  );
}

describe('assistant empty state', () => {
  beforeEach(() => {
    state.messages = [];
    state.send.mockReset();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
  });

  it('offers suggestion questions that send the question when tapped', () => {
    open();
    const group = document.body.querySelector('[aria-label="Suggestion questions"]');
    expect(group).not.toBeNull();
    const buttons = Array.from(group!.querySelectorAll('button'));
    expect(buttons.length).toBe(6);
    expect(buttons[0].textContent).toBe('How much did I collect this week?');
    fireEvent.click(buttons[0]);
    expect(state.send).toHaveBeenCalledWith('How much did I collect this week?');
  });

  it('greets the person by first name', () => {
    open();
    expect(document.body.textContent).toContain('Hi Ssenkaali');
    expect(document.body.textContent).toContain("I'm Clara");
  });

  it('drops the empty-state suggestions once a conversation has started', () => {
    state.messages = [{ id: '1', role: 'user', content: 'hello' }];
    open();
    expect(document.body.querySelector('[aria-label="Suggestion questions"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Suggestions"]')).not.toBeNull();
  });
});
