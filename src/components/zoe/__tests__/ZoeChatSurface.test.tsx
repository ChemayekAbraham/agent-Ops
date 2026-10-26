import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ZoeChatSurface } from '../ZoeChatSurface';
import type { ZoeMessage } from '../useZoeAssistant';

function renderSurface(props: Partial<React.ComponentProps<typeof ZoeChatSurface>> = {}) {
  const defaultProps: React.ComponentProps<typeof ZoeChatSurface> = {
    messages: [],
    roles: ['employee'],
    isLoading: false,
    isHistoryLoading: false,
    errorMessage: null,
    remainingQuestionsToday: 45,
    onSendMessage: vi.fn(),
    onRetry: vi.fn(),
    onFeedback: vi.fn(),
    onClearHistory: vi.fn(),
    ...props,
  };

  return {
    ...render(
      <MemoryRouter>
        <ZoeChatSurface {...defaultProps} />
      </MemoryRouter>,
    ),
    props: defaultProps,
  };
}

describe('ZoeChatSurface', () => {
  it('renders empty state with role-based suggestion chips and sends prompt on tap', () => {
    const onSendMessage = vi.fn();
    renderSurface({
      messages: [],
      roles: ['tenant_ops'],
      onSendMessage,
    });

    expect(screen.getByTestId('zoe-empty-state')).toBeInTheDocument();
    // Personal My Space suggestion
    expect(screen.getByTestId('zoe-suggestion-my-tasks')).toBeInTheDocument();
    // Tenant Ops role-scoped suggestion
    const topsChip = screen.getByTestId('zoe-suggestion-tops-arrears');
    expect(topsChip).toHaveTextContent('Tenant Ops arrears ageing');
    // Landlord Ops suggestion should not appear for a tenant_ops-only caller
    expect(screen.queryByTestId('zoe-suggestion-lops-home')).not.toBeInTheDocument();

    fireEvent.click(topsChip);
    expect(onSendMessage).toHaveBeenCalledWith(
      'Show the Tenant Ops arrears ageing summary as of today.',
    );
  });

  it('renders typing indicator while loading and disables composer controls', () => {
    renderSurface({
      messages: [{ id: 'u-1', role: 'user', content: 'Show my tasks' }],
      isLoading: true,
    });

    const indicator = screen.getByTestId('zoe-typing-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('Zoe is reading official records...');
    expect(screen.getByTestId('zoe-input')).toBeDisabled();
    expect(screen.getByTestId('zoe-send-button')).toBeDisabled();
  });

  it('renders error message banner with Retry button and triggers onRetry when clicked', () => {
    const onRetry = vi.fn();
    renderSurface({
      messages: [{ id: 'u-1', role: 'user', content: 'Show my payslips' }],
      errorMessage: "I'm having trouble reading that report right now. Please try again in a moment.",
      onRetry,
    });

    const banner = screen.getByTestId('zoe-error-banner');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent("I'm having trouble reading that report right now.");

    const retryBtn = screen.getByTestId('zoe-retry-button');
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders answer with Source · dates line and link to the matching screen', () => {
    const messages: ZoeMessage[] = [
      { id: 'u-1', role: 'user', content: 'What is the Tenant Ops arrears total?' },
      {
        id: 'a-1',
        role: 'assistant',
        content:
          'Overdue Rent Plans total UGX 1,450,000 across 18 plans.\n\nSource: tops_arrears_ageing_amclock · Period: as of 2026-10-26',
        outcome: 'answered',
        source: 'tops_arrears_ageing_amclock',
        period: 'as of 2026-10-26',
      },
    ];

    renderSurface({ messages, roles: ['tenant_ops'] });

    expect(
      screen.getByText('Overdue Rent Plans total UGX 1,450,000 across 18 plans.'),
    ).toBeInTheDocument();

    const sourceLine = screen.getByTestId('zoe-source-line');
    expect(sourceLine).toHaveTextContent('Source: tops_arrears_ageing_amclock · as of 2026-10-26');

    const screenLink = screen.getByTestId('zoe-screen-link');
    expect(screenLink).toHaveTextContent('Open Tenant Ops Workspace');
    expect(screenLink).toHaveAttribute('href', '/tenant-ops/workspace');
  });

  it('submits thumbs up/down feedback and supports Clear my history', () => {
    const onFeedback = vi.fn();
    const onClearHistory = vi.fn();
    const messages: ZoeMessage[] = [
      { id: 'u-1', role: 'user', content: 'Show my recent payslips' },
      {
        id: 'a-1',
        role: 'assistant',
        content: 'Your latest net pay is UGX 850,000.',
        outcome: 'answered',
        source: 'hr_pay_my_payslips',
        period: 'as of 2026-10-26',
        feedback: 'up',
      },
    ];

    renderSurface({ messages, onFeedback, onClearHistory });

    const upBtn = screen.getByTestId('zoe-feedback-up-a-1');
    const downBtn = screen.getByTestId('zoe-feedback-down-a-1');
    expect(upBtn).toHaveAttribute('aria-pressed', 'true');
    expect(downBtn).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(downBtn);
    expect(onFeedback).toHaveBeenCalledWith('a-1', 'down');

    const clearBtn = screen.getByTestId('zoe-clear-history');
    fireEvent.click(clearBtn);
    expect(onClearHistory).toHaveBeenCalledTimes(1);
  });
});
