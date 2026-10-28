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

  it('shows only the two small offer chips (Excel / PDF) when a table answer has no file request, and shows Download ready when requested or tapped', async () => {
    const unrequestedTableMessages: ZoeMessage[] = [
      { id: 'u-1', role: 'user', content: 'Show Tenant Ops repayments for October' },
      {
        id: 'a-1',
        role: 'assistant',
        content: 'Here are the 2 Tenant Ops repayment rows for October 2026.',
        outcome: 'answered',
        source: 'get_tenant_ops_repayments',
        period: '2026-10-01 to 2026-10-26',
        createdAt: '2026-10-26T06:30:00.000Z',
        reportPayload: {
          tool: 'tenant_ops_repayments',
          rpc: 'assistant_staff_tenant_ops_repayments',
          source: 'get_tenant_ops_repayments',
          period: { from: '2026-10-01', to: '2026-10-26' },
          row_count: 2,
          rows: [
            { tenant_name: 'Namukasa Grace', collected_total: 300000, stage: 'repaying' },
            { tenant_name: 'Okello Ronald', collected_total: 600000, stage: 'completed' },
          ],
        },
      },
    ];

    const { unmount } = renderSurface({
      messages: unrequestedTableMessages,
      roles: ['tenant_ops'],
      generatedBy: 'Winfred Asiimwe (winnie@welile.com)',
    });

    // Unrequested table: shows the two small offer chips, NOT the Download ready card
    expect(screen.getByTestId('zoe-file-offer-row')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-offer-excel-chip')).toHaveTextContent('Excel (.xlsx)');
    expect(screen.getByTestId('zoe-offer-pdf-chip')).toHaveTextContent('PDF');
    expect(screen.queryByTestId('zoe-report-card')).not.toBeInTheDocument();
    unmount();

    // Requested file ("Give me an Excel for Tenant Ops repayments"): shows Download ready row
    const requestedMessages: ZoeMessage[] = [
      {
        id: 'u-2',
        role: 'user',
        content: 'Give me an Excel for Tenant Ops repayments in October',
      },
      unrequestedTableMessages[1],
    ];

    renderSurface({
      messages: requestedMessages,
      roles: ['tenant_ops'],
      generatedBy: 'Winfred Asiimwe (winnie@welile.com)',
    });

    expect(screen.getByTestId('zoe-report-card')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-download-ready-row')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-download-ready-badge')).toHaveTextContent('Download ready');
    expect(screen.getByTestId('zoe-report-title')).toHaveTextContent(
      'Tenant Ops Repayments & Collection Rate Report',
    );
    expect(screen.getByTestId('zoe-report-dates')).toHaveTextContent('2026-10-01 to 2026-10-26');
    expect(screen.getByTestId('zoe-report-row-count')).toHaveTextContent('2 rows');
    expect(screen.getByTestId('zoe-report-generated-by')).toHaveTextContent(
      'Winfred Asiimwe (winnie@welile.com)',
    );
    expect(screen.getByTestId('zoe-report-how-counted')).toHaveTextContent(
      'get_tenant_ops_repayments',
    );
    expect(screen.getByTestId('zoe-report-pdf-button')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-report-excel-button')).toBeInTheDocument();
  });

  it('renders the email draft card with To, Subject, message, attachment preview, multi-match picker, Edit, Cancel, and only calls onSendEmail when Send is pressed', async () => {
    const onSendEmail = vi.fn().mockResolvedValue({
      ok: true,
      sent: true,
      recipient_email: 'jane@welile.com',
      recipient_name: 'Janehephzibar Gimono',
      attachment_filename: 'welile-zoe-tenant-ops-repayments-2026-10-26.pdf',
      remaining_emails_today: 29,
    });

    const messages: ZoeMessage[] = [
      { id: 'u-1', role: 'user', content: 'Email this report to Jane' },
      {
        id: 'a-draft-1',
        role: 'assistant',
        content: 'Several active Welile staff members match. Please pick who should receive the report draft:',
        outcome: 'clarify',
        source: 'get_tenant_ops_repayments',
        period: '2026-10-01 to 2026-10-26',
        reportPayload: {
          tool: 'get_tops_arrears_ageing',
          rpc: 'assistant_staff_tops_arrears_ageing',
          source: 'tops_arrears_ageing_amclock',
          period: { as_of: '2026-10-26' },
          row_count: 2,
          rows: [
            { bucket: '1-7 days', overdue_ugx: 850000 },
            { bucket: '8-14 days', overdue_ugx: 600000 },
          ],
          email_draft: {
            draft_id: 'draft-123',
            status: 'pick_recipient',
            recipient_user_id: null,
            recipient_name: null,
            recipient_email: null,
            recipient_roles: [],
            subject: 'Report shared from Zoe: Tenant Ops Arrears Ageing (as of 2026-10-26)',
            message: 'Please find attached the Tenant Ops Arrears Ageing report.',
            report_reference: {
              tool: 'get_tops_arrears_ageing',
              rpc: 'assistant_staff_tops_arrears_ageing',
              args: {},
              source: 'tops_arrears_ageing_amclock',
              period: 'as of 2026-10-26',
              title: 'Tenant Ops Arrears Ageing Report',
              row_count: 2,
              filename: 'welile-zoe-tenant-ops-arrears-ageing-2026-10-26.pdf',
            },
            candidates: [
              {
                staff_user_id: 'staff-1',
                full_name: 'Janehephzibar Gimono',
                email: 'jane@welile.com',
                roles: ['tenant_ops'],
              },
              {
                staff_user_id: 'staff-2',
                full_name: 'Winfred Asiimwe',
                email: 'winnie@welile.com',
                roles: ['tenant_ops'],
              },
            ],
          },
        },
      },
    ];

    renderSurface({
      messages,
      roles: ['tenant_ops'],
      onSendEmail,
    });

    // Draft card is rendered and has NOT sent anything yet
    expect(screen.getByTestId('zoe-email-draft-card')).toBeInTheDocument();
    expect(onSendEmail).not.toHaveBeenCalled();

    // Multi-match picker is shown and Send is disabled until a staff member is picked
    expect(screen.getByTestId('zoe-email-draft-recipient-picker')).toBeInTheDocument();
    const sendBtn = screen.getByTestId('zoe-email-draft-send');
    expect(sendBtn).toBeDisabled();

    // Pick Jane from the candidates
    fireEvent.click(screen.getByTestId('zoe-email-candidate-jane@welile.com'));
    expect(screen.getByTestId('zoe-email-draft-to')).toHaveTextContent(
      'Janehephzibar Gimono <jane@welile.com>',
    );
    expect(sendBtn).not.toBeDisabled();

    // Attachment preview shows PDF filename and row count
    expect(screen.getByTestId('zoe-email-draft-attachment')).toHaveTextContent(
      'welile-zoe-tenant-ops-arrears-ageing-2026-10-26.pdf',
    );
    expect(screen.getByTestId('zoe-email-draft-attachment')).toHaveTextContent('2 rows · PDF attached');

    // Click Edit and update Subject and Message
    fireEvent.click(screen.getByTestId('zoe-email-draft-edit'));
    fireEvent.change(screen.getByTestId('zoe-email-draft-subject-input'), {
      target: { value: 'Updated Subject: Tenant Ops Arrears' },
    });
    fireEvent.change(screen.getByTestId('zoe-email-draft-message-input'), {
      target: { value: 'Hi Jane, please review this updated report.' },
    });
    fireEvent.click(screen.getByTestId('zoe-email-draft-edit'));
    expect(screen.getByTestId('zoe-email-draft-subject')).toHaveTextContent(
      'Updated Subject: Tenant Ops Arrears',
    );

    // Click Cancel -> draft is cancelled without calling onSendEmail, then restore it
    fireEvent.click(screen.getByTestId('zoe-email-draft-cancel'));
    expect(screen.getByTestId('zoe-email-draft-cancelled')).toBeInTheDocument();
    expect(onSendEmail).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Restore draft'));

    // Click Send -> calls onSendEmail once with the edited subject and message
    fireEvent.click(screen.getByTestId('zoe-email-draft-send'));
    expect(onSendEmail).toHaveBeenCalledTimes(1);
    expect(onSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_email: 'jane@welile.com',
        recipient_name: 'Janehephzibar Gimono',
        subject: 'Updated Subject: Tenant Ops Arrears',
        message: 'Hi Jane, please review this updated report.',
      }),
    );

    expect(await screen.findByTestId('zoe-email-draft-sent')).toHaveTextContent(
      'Report shared from Zoe',
    );
  });

  it('renders Markdown tables, mini charts with written summary, follow-up chips, Copy/Regenerate/Show the data buttons, conversation list drawer with Rename and New chat, Stop button, and 2,000-char input limit', () => {
    const onSendMessage = vi.fn();
    const onRegenerate = vi.fn();
    const onStopGenerating = vi.fn();
    const onStartNewChat = vi.fn().mockResolvedValue('conv-new');
    const onSelectConversation = vi.fn().mockResolvedValue(undefined);
    const onRenameConversation = vi.fn().mockResolvedValue(true);

    const messages: ZoeMessage[] = [
      { id: 'u-1', role: 'user', content: 'Give me the full breakdown of Rent Plans by stage' },
      {
        id: 'a-1',
        role: 'assistant',
        content: [
          '### Rent Plans by Stage',
          '',
          '| Stage | Plans | Principal |',
          '| --- | --- | --- |',
          '| Pending Landlord Ops | 14 | UGX 18,400,000 |',
          '| Repaying | 82 | UGX 112,000,000 |',
          '',
          'Source: assistant_staff_tops_rent_requests_by_stage · Period: as of 2026-10-26',
        ].join('\n'),
        outcome: 'answered',
        source: 'assistant_staff_tops_rent_requests_by_stage',
        period: 'as of 2026-10-26',
        followUpSuggestions: [
          'How long have pending Rent Plans been sitting on each desk?',
          'Compare this week with last week',
        ],
        reportPayload: {
          tool: 'get_tops_rent_requests_by_stage',
          rpc: 'assistant_staff_tops_rent_requests_by_stage',
          source: 'assistant_staff_tops_rent_requests_by_stage',
          period: { as_of: '2026-10-26' },
          row_count: 2,
          rows: [
            { stage: 'Repaying', count: 82, total_ugx: 112000000 },
            { stage: 'Pending Landlord Ops', count: 14, total_ugx: 18400000 },
          ],
          chart: {
            type: 'bar',
            title: 'Rent Plans by Stage',
            summary:
              'Repaying leads with 82 across 2 ranked items (total 96) for as of 2026-10-26.',
            xKey: 'stage',
            yKey: 'count',
            isUgx: false,
            data: [
              { label: 'Repaying', value: 82 },
              { label: 'Pending Landlord Ops', value: 14 },
            ],
          },
        },
      },
    ];

    renderSurface({
      messages,
      roles: ['tenant_ops'],
      statusLine: 'Comparing weeks…',
      isLoading: false,
      conversations: [
        {
          id: 'conv-1',
          title: 'Rent Plans by stage',
          message_count: 4,
          last_active_at: '2026-10-26T08:00:00Z',
          created_at: '2026-10-26T07:50:00Z',
        },
      ],
      activeConversationId: 'conv-1',
      onSendMessage,
      onRegenerate,
      onStopGenerating,
      onStartNewChat,
      onSelectConversation,
      onRenameConversation,
    });

    // 1. 2,000-character limit on input textarea
    expect(screen.getByTestId('zoe-input')).toHaveAttribute('maxLength', '2000');

    // 2. Markdown heading and table rendered
    expect(screen.getByTestId('zoe-markdown')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-markdown-table')).toBeInTheDocument();
    expect(screen.getAllByText('Pending Landlord Ops').length).toBeGreaterThanOrEqual(1);

    // 3. Mini chart with one-line summary rendered
    expect(screen.getByTestId('zoe-mini-chart')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-mini-chart-summary')).toHaveTextContent(
      'Repaying leads with 82 across 2 ranked items',
    );

    // 4. Copy, Regenerate, and "Show the data" buttons
    expect(screen.getByTestId('zoe-copy-a-1')).toBeInTheDocument();
    const regenBtn = screen.getByTestId('zoe-regenerate-a-1');
    fireEvent.click(regenBtn);
    expect(onRegenerate).toHaveBeenCalledTimes(1);

    const showDataBtn = screen.getByTestId('zoe-show-data-a-1');
    expect(showDataBtn).toHaveTextContent('Show the data');
    fireEvent.click(showDataBtn);
    expect(screen.getByTestId('zoe-raw-data-table-a-1')).toBeInTheDocument();

    // 5. Follow-up suggestion chips under answer
    expect(screen.getByTestId('zoe-follow-ups-a-1')).toBeInTheDocument();
    fireEvent.click(
      screen.getByText('How long have pending Rent Plans been sitting on each desk?'),
    );
    expect(onSendMessage).toHaveBeenCalledWith(
      'How long have pending Rent Plans been sitting on each desk?',
    );

    // 6. Conversation list drawer with Rename and New chat
    fireEvent.click(screen.getByTestId('zoe-new-chat-button'));
    expect(onStartNewChat).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('zoe-conversations-toggle'));
    expect(screen.getByTestId('zoe-conversation-drawer')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('zoe-conv-rename-btn-conv-1'));
    fireEvent.change(screen.getByTestId('zoe-conv-rename-input-conv-1'), {
      target: { value: 'October Stage Breakdown' },
    });
    fireEvent.click(screen.getByTestId('zoe-conv-rename-save-conv-1'));
    expect(onRenameConversation).toHaveBeenCalledWith('conv-1', 'October Stage Breakdown');
  });

  it('renders Zoe notes drawer (view, add, reject figures/PII error, delete) and Glossary drawer with manager-only editor', async () => {
    const onAddNote = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: 'Zoe notes can only store short personal preferences (no UGX figures).',
      })
      .mockResolvedValueOnce({ ok: true });
    const onDeleteNote = vi.fn().mockResolvedValue({ ok: true });
    const onSaveGlossaryEntry = vi.fn().mockResolvedValue({ ok: true });

    const { unmount } = renderSurface({
      messages: [],
      roles: ['employee'],
      notes: [
        {
          id: 'note-1',
          note_text: 'Show Kampala West first',
          created_at: '2026-10-28T08:00:00Z',
        },
      ],
      onAddNote,
      onDeleteNote,
      onSaveGlossaryEntry,
    });

    // Open Zoe notes drawer
    fireEvent.click(screen.getByTestId('zoe-notes-toggle'));
    expect(screen.getByTestId('zoe-notes-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-note-item-note-1')).toHaveTextContent('Show Kampala West first');

    // Attempt to add a note rejected by the guard
    fireEvent.change(screen.getByTestId('zoe-note-input'), {
      target: { value: 'Target UGX 5,000,000' },
    });
    fireEvent.click(screen.getByTestId('zoe-note-add-button'));
    expect(await screen.findByTestId('zoe-note-error')).toHaveTextContent(
      'Zoe notes can only store short personal preferences',
    );

    // Add a valid note
    fireEvent.change(screen.getByTestId('zoe-note-input'), {
      target: { value: 'Keep summaries under 5 bullet points' },
    });
    fireEvent.click(screen.getByTestId('zoe-note-add-button'));
    expect(onAddNote).toHaveBeenCalledWith('Keep summaries under 5 bullet points');

    // Delete existing note
    fireEvent.click(screen.getByTestId('zoe-note-delete-note-1'));
    expect(onDeleteNote).toHaveBeenCalledWith('note-1');

    // Open Glossary drawer as regular employee -> sees definitions & measurement gotchas, but NO manager form
    fireEvent.click(screen.getByTestId('zoe-glossary-toggle'));
    expect(screen.getByTestId('zoe-glossary-drawer')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-glossary-item-expected_vs_collected')).toBeInTheDocument();
    expect(screen.queryByTestId('zoe-glossary-manager-form')).not.toBeInTheDocument();
    unmount();

    // Render as manager -> sees manager glossary editor and can save a term
    renderSurface({
      messages: [],
      roles: ['manager'],
      onSaveGlossaryEntry,
    });
    fireEvent.click(screen.getByTestId('zoe-glossary-toggle'));
    expect(screen.getByTestId('zoe-glossary-manager-form')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('zoe-glossary-key-input'), {
      target: { value: 'custom_term' },
    });
    fireEvent.change(screen.getByTestId('zoe-glossary-title-input'), {
      target: { value: 'Custom Operational Term' },
    });
    fireEvent.change(screen.getByTestId('zoe-glossary-definition-input'), {
      target: { value: 'Official definition for staff operations.' },
    });
    fireEvent.click(screen.getByTestId('zoe-glossary-save-button'));
    expect(onSaveGlossaryEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'custom_term',
        term: 'Custom Operational Term',
        plain_definition: 'Official definition for staff operations.',
      }),
    );
  });
});
