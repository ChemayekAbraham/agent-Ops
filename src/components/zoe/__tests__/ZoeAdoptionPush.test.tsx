import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    },
    functions: {
      invoke: vi.fn(),
    },
    rpc: vi.fn(),
    from: vi.fn(),
  },
}));

import {
  MeetTheNewZoeBanner,
  hasSeenMeetNewZoeNotice,
  MEET_NEW_ZOE_STORAGE_PREFIX,
} from '../MeetTheNewZoeBanner';
import { ZoeChatSurface } from '../ZoeChatSurface';
import {
  getEmptyChatExampleQuestions,
  ZOE_EMPTY_CHAT_EXAMPLE_QUESTIONS,
  ZOE_MANAGER_ADOPTION_NOTE_LINES,
} from '../zoeConfig';

describe('Prompt 3 Deliverable (1) — Zoe Adoption Push', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the "Meet the new Zoe" notice once on first open and persists dismissal in localStorage', () => {
    expect(hasSeenMeetNewZoeNotice('staff-user-1')).toBe(false);

    const { unmount } = render(
      <MemoryRouter initialEntries={['/me']}>
        <MeetTheNewZoeBanner
          userId="staff-user-1"
          roles={['employee']}
          enabled={true}
        />
      </MemoryRouter>,
    );

    const banner = screen.getByTestId('meet-the-new-zoe-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('Meet the new Zoe');
    // Non-manager does not see the manager two-line note
    expect(screen.queryByTestId('zoe-manager-two-line-note')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('meet-the-new-zoe-dismiss-btn'));
    expect(screen.queryByTestId('meet-the-new-zoe-banner')).not.toBeInTheDocument();
    expect(hasSeenMeetNewZoeNotice('staff-user-1')).toBe(true);
    expect(localStorage.getItem(`${MEET_NEW_ZOE_STORAGE_PREFIX}:staff-user-1`)).toBe('1');

    unmount();

    // Re-mounting after dismissal does not show the notice again
    render(
      <MemoryRouter initialEntries={['/me']}>
        <MeetTheNewZoeBanner
          userId="staff-user-1"
          roles={['employee']}
          enabled={true}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('meet-the-new-zoe-banner')).not.toBeInTheDocument();
  });

  it('includes the two-line note to managers inside the "Meet the new Zoe" notice and on the empty-chat screen', () => {
    render(
      <MemoryRouter initialEntries={['/me']}>
        <MeetTheNewZoeBanner
          userId="mgr-user-1"
          roles={['manager', 'coo']}
          enabled={true}
        />
      </MemoryRouter>,
    );

    const mgrNote = screen.getByTestId('zoe-manager-two-line-note');
    expect(mgrNote).toBeInTheDocument();
    expect(mgrNote).toHaveTextContent(ZOE_MANAGER_ADOPTION_NOTE_LINES[0]);
    expect(mgrNote).toHaveTextContent(ZOE_MANAGER_ADOPTION_NOTE_LINES[1]);
  });

  it('renders 10 example questions on Zoe empty-chat screen pulled from Clara and unanswered logs, plus manager note', () => {
    const examples = getEmptyChatExampleQuestions(['manager'], 10);
    expect(examples).toHaveLength(10);
    expect(ZOE_EMPTY_CHAT_EXAMPLE_QUESTIONS).toHaveLength(10);

    const onSendMessage = vi.fn();
    render(
      <MemoryRouter initialEntries={['/me/zoe']}>
        <ZoeChatSurface
          messages={[]}
          roles={['manager']}
          isLoading={false}
          isHistoryLoading={false}
          errorMessage={null}
          remainingQuestionsToday={45}
          onSendMessage={onSendMessage}
          onRetry={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
        />
      </MemoryRouter>,
    );

    const examplesContainer = screen.getByTestId('zoe-empty-chat-examples');
    expect(examplesContainer).toBeInTheDocument();

    for (let i = 0; i < 10; i += 1) {
      expect(screen.getByTestId(`zoe-empty-example-${i}`)).toBeInTheDocument();
    }

    // Verify Clara-derived and unanswered-log-derived questions are present
    expect(screen.getByTestId('zoe-empty-example-0')).toHaveTextContent(
      'What is my personal wallet balance in My Space?',
    );
    expect(screen.getByTestId('zoe-empty-example-2')).toHaveTextContent(
      'Explain what receivables mean in Welile in plain English',
    );
    expect(screen.getByTestId('zoe-empty-example-3')).toHaveTextContent(
      'If I want to call tenants or landlords, where do I go?',
    );

    // Clicking an example question dispatches its prompt
    fireEvent.click(screen.getByTestId('zoe-empty-example-2'));
    expect(onSendMessage).toHaveBeenCalledWith(
      'Explain what receivables mean in Welile in plain, simple English.',
    );

    // Manager viewer also sees the two-line note on the empty chat screen
    const emptyChatMgrNote = screen.getByTestId('zoe-empty-chat-manager-note');
    expect(emptyChatMgrNote).toHaveTextContent(ZOE_MANAGER_ADOPTION_NOTE_LINES[0]);
    expect(emptyChatMgrNote).toHaveTextContent(ZOE_MANAGER_ADOPTION_NOTE_LINES[1]);
  });
});
