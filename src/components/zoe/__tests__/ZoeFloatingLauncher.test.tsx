import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUseAuth = vi.fn();
const mockUseZoeAccess = vi.fn();
const mockUseZoeAssistant = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('../useZoeAssistant', () => ({
  useZoeAccess: () => mockUseZoeAccess(),
  useZoeAssistant: (...args: unknown[]) => mockUseZoeAssistant(...args),
}));

vi.mock('../ZoeChatSurface', () => ({
  ZoeChatSurface: ({ headerSlot }: { headerSlot?: React.ReactNode }) => (
    <div data-testid="mock-zoe-chat-surface">{headerSlot}</div>
  ),
}));

import {
  deriveFirstNameForGreeting,
  formatZoeGreetingMessage,
  GREETING_FADE_MS,
  GREETING_MS,
  resetZoeGreetingForTest,
  ZoeFloatingLauncher,
} from '../ZoeFloatingLauncher';

function createAssistantMock() {
  return {
    messages: [],
    conversations: [],
    activeConversationId: null,
    notes: [],
    glossaryEntries: [],
    knowledgeEntries: [],
    personalisedStarters: [],
    projects: [],
    activeProjectId: null,
    taughtUpdates: [],
    pushPrefs: null,
    pageContext: null,
    memoryEnabled: true,
    temporaryChat: false,
    memorySuggestion: null,
    isLoading: false,
    isHistoryLoading: false,
    streamingText: '',
    statusLine: null,
    researchMode: false,
    researchPlanSteps: [],
    errorMessage: null,
    remainingQuestionsToday: 50,
    setPageContext: vi.fn(),
    setResearchMode: vi.fn(),
    setMemoryEnabled: vi.fn(),
    setTemporaryChat: vi.fn(),
    setActiveProjectId: vi.fn(),
    saveProject: vi.fn(),
    deleteProject: vi.fn(),
    updatePushPrefs: vi.fn(),
    acceptMemorySuggestion: vi.fn(),
    dismissMemorySuggestion: vi.fn(),
    sendMessage: vi.fn(),
    stopGenerating: vi.fn(),
    regenerateLastAnswer: vi.fn(),
    selectConversation: vi.fn(),
    startNewChat: vi.fn(),
    renameConversation: vi.fn(),
    deleteConversation: vi.fn(),
    retryLastMessage: vi.fn(),
    submitFeedback: vi.fn(),
    clearHistory: vi.fn(),
    addNote: vi.fn(),
    updateNote: vi.fn(),
    deleteNote: vi.fn(),
    saveGlossaryEntry: vi.fn(),
    saveKnowledgeEntry: vi.fn(),
  };
}

function RouteChangeHarness() {
  const navigate = useNavigate();
  return (
    <div>
      <button
        type="button"
        data-testid="navigate-to-reports"
        onClick={() => navigate('/me/reports')}
      >
        Go to Reports
      </button>
      <ZoeFloatingLauncher />
    </div>
  );
}

describe('ZoeFloatingLauncher — avatar identity and once-per-visit greeting bubble', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetZoeGreetingForTest();
    mockUseAuth.mockReturnValue({
      user: {
        id: 'user-winnie',
        email: 'winnie.asiimwe@welile.com',
        user_metadata: { full_name: 'Winfred Asiimwe' },
      },
      roles: ['landlord_ops'],
    });
    mockUseZoeAccess.mockReturnValue({ data: true });
    mockUseZoeAssistant.mockReturnValue(createAssistantMock());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('derives first name cleanly and formats the greeting bubble message', () => {
    expect(deriveFirstNameForGreeting('Winfred Asiimwe', 'winnie@welile.com')).toBe('Winfred');
    expect(deriveFirstNameForGreeting(null, 'jane.gimono@welile.com')).toBe('Jane');
    expect(formatZoeGreetingMessage('Winfred')).toBe(
      'Hi Winfred, need a hand with a report or question?',
    );
    expect(formatZoeGreetingMessage('')).toBe('Hi, need a hand with a report or question?');
  });

  it('renders Zoe avatar on the launcher and shows the first-name greeting bubble once per visit, fading on its own', () => {
    render(
      <MemoryRouter initialEntries={['/me']}>
        <ZoeFloatingLauncher />
      </MemoryRouter>,
    );

    const avatar = screen.getByTestId('zoe-launcher-avatar');
    expect(avatar).toBeTruthy();
    expect(avatar.getAttribute('alt')).toBe('Zoe');

    const bubble = screen.getByTestId('zoe-greeting-bubble');
    expect(bubble.textContent).toContain('Hi Winfred, need a hand with a report or question?');

    act(() => {
      vi.advanceTimersByTime(GREETING_MS - GREETING_FADE_MS);
    });
    expect(screen.getByTestId('zoe-greeting-bubble').className).toContain('opacity-0');

    act(() => {
      vi.advanceTimersByTime(GREETING_FADE_MS + 10);
    });
    expect(screen.queryByTestId('zoe-greeting-bubble')).toBeNull();
  });

  it('never re-shows the greeting bubble on a route change or component remount during the same page load', () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/me']}>
        <RouteChangeHarness />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-greeting-bubble')).toBeTruthy();

    fireEvent.click(screen.getByTestId('zoe-greeting-dismiss'));
    expect(screen.queryByTestId('zoe-greeting-bubble')).toBeNull();

    // Navigate to another My Space route
    fireEvent.click(screen.getByTestId('navigate-to-reports'));
    expect(screen.queryByTestId('zoe-greeting-bubble')).toBeNull();

    // Even if unmounted and remounted on another workspace layout within the same page visit
    unmount();
    render(
      <MemoryRouter initialEntries={['/me/work']}>
        <ZoeFloatingLauncher />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('zoe-greeting-bubble')).toBeNull();
  });

  it('suppresses the greeting bubble and floating launcher while the chat sheet is open', () => {
    render(
      <MemoryRouter initialEntries={['/me']}>
        <ZoeFloatingLauncher />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-greeting-bubble')).toBeTruthy();

    fireEvent.click(screen.getByTestId('zoe-floating-button'));

    expect(screen.queryByTestId('zoe-greeting-bubble')).toBeNull();
    expect(screen.queryByTestId('zoe-floating-button')).toBeNull();
    expect(screen.getByTestId('mock-zoe-chat-surface')).toBeTruthy();
  });
});
