import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ZoeConversationsPanel } from '../ZoeConversationsPanel';
import {
  canReviewZoeConversations,
  computeBudgetUtilizationPct,
  filterZoeConversations,
  ZOE_CRM_REVIEWER_ROLES,
  type ZoeCrmConversationRow,
  type ZoeCrmDashboardData,
  type ZoeCrmThreadMessage,
} from '@/hooks/useZoeCrm';

const mockUseAuth = vi.fn();
const mockUseZoeCrmDashboard = vi.fn();
const mockUseZoeCrmThread = vi.fn();
const mockMutate = vi.fn();

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock('@/hooks/useZoeCrm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useZoeCrm')>();
  return {
    ...actual,
    useZoeCrmDashboard: (filters: unknown, enabled: boolean) =>
      mockUseZoeCrmDashboard(filters, enabled),
    useZoeCrmThread: (convId: string | null) => mockUseZoeCrmThread(convId),
    useUpdateZoeUnanswered: () => ({
      mutate: mockMutate,
      isPending: false,
    }),
  };
});

const SAMPLE_CONVERSATIONS: ZoeCrmConversationRow[] = [
  {
    id: 'conv-tops-1',
    user_id: 'user-jane',
    staff_name: 'Janehephzibar Gimono',
    staff_email: 'jane@welile.com',
    staff_phone: '256700111222',
    staff_roles: ['tenant_ops'],
    title: 'Pipeline waiting Landlord Ops',
    last_message_at: '2026-10-26T07:30:00Z',
    created_at: '2026-10-26T07:20:00Z',
    session_context: { route: '/me/zoe' },
    message_count: 4,
    assistant_count: 2,
    thumbs_up_count: 0,
    thumbs_down_count: 1,
    unanswered_count: 0,
    has_thumbs_down: true,
    has_unanswered: false,
    last_user_question: 'Which Rent Plans are waiting on Landlord Ops?',
    last_outcome: 'answered',
    last_tools_called: ['assistant_staff_tops_pipeline_waiting_on_lops'],
  },
  {
    id: 'conv-lops-2',
    user_id: 'user-winnie',
    staff_name: 'Winfred Asiimwe',
    staff_email: 'winnie@welile.com',
    staff_phone: '256700333444',
    staff_roles: ['landlord_ops'],
    title: 'Forecast landlord churn',
    last_message_at: '2026-10-26T07:45:00Z',
    created_at: '2026-10-26T07:40:00Z',
    session_context: { route: '/me/zoe' },
    message_count: 2,
    assistant_count: 1,
    thumbs_up_count: 0,
    thumbs_down_count: 0,
    unanswered_count: 1,
    has_thumbs_down: false,
    has_unanswered: true,
    last_user_question: 'Predict next year landlord churn rate in Gulu',
    last_outcome: 'unanswered',
    last_tools_called: [],
  },
  {
    id: 'conv-cfo-3',
    user_id: 'user-cfo',
    staff_name: 'Finance Director',
    staff_email: 'cfo@welile.com',
    staff_phone: '256700555666',
    staff_roles: ['cfo', 'fin_ops'],
    title: 'Treasury cash position',
    last_message_at: '2026-10-26T07:50:00Z',
    created_at: '2026-10-26T07:48:00Z',
    session_context: { route: '/me/zoe' },
    message_count: 2,
    assistant_count: 1,
    thumbs_up_count: 1,
    thumbs_down_count: 0,
    unanswered_count: 0,
    has_thumbs_down: false,
    has_unanswered: false,
    last_user_question: 'What is our cash position today?',
    last_outcome: 'answered',
    last_tools_called: ['get_cfo_treasury_cash_position'],
  },
];

const SAMPLE_DASHBOARD: ZoeCrmDashboardData = {
  generated_at: '2026-10-26T08:00:00Z',
  kampala_date: '2026-10-26',
  config: {
    enabled: true,
    max_questions_per_day: 50,
    max_emails_per_day: 30,
    history_days: 90,
  },
  summary: {
    total_conversations: 3,
    conversations_with_thumbs_down: 1,
    conversations_with_unanswered: 1,
    open_unanswered_count: 2,
    active_staff_today: 3,
    questions_asked_today: 19,
    emails_sent_today: 4,
  },
  available_roles: ['cfo', 'fin_ops', 'landlord_ops', 'tenant_ops'],
  conversations: SAMPLE_CONVERSATIONS,
  weekly_unanswered_summary: [
    {
      normalized_question: 'predict next year landlord churn rate in gulu',
      question_text: 'Predict next year landlord churn rate in Gulu',
      ask_count: 5,
      unique_staff_count: 3,
      roles_asking: ['landlord_ops', 'tenant_ops'],
      latest_reason: 'no_matching_tool',
      latest_status: 'open',
      latest_id: 'unans-1',
      latest_review_note: null,
      first_seen_at: '2026-10-22T10:00:00Z',
      last_seen_at: '2026-10-26T07:45:00Z',
    },
    {
      normalized_question: 'what is the ceo private bank balance',
      question_text: 'What is the CEO private bank balance?',
      ask_count: 2,
      unique_staff_count: 2,
      roles_asking: ['tenant_ops'],
      latest_reason: 'role_restricted',
      latest_status: 'reviewed',
      latest_id: 'unans-2',
      latest_review_note: 'Correctly refused by role gate.',
      first_seen_at: '2026-10-24T09:00:00Z',
      last_seen_at: '2026-10-25T15:00:00Z',
    },
  ],
  daily_usage_per_person: [
    {
      user_id: 'user-jane',
      staff_name: 'Janehephzibar Gimono',
      staff_email: 'jane@welile.com',
      staff_roles: ['tenant_ops'],
      questions_today: 12,
      max_questions_per_day: 50,
      questions_remaining: 38,
      budget_utilization_pct: 24,
      emails_today: 3,
      max_emails_per_day: 30,
      emails_remaining: 27,
      thumbs_down_today: 1,
      unanswered_today: 0,
      last_active_at: '2026-10-26T07:30:00Z',
    },
    {
      user_id: 'user-winnie',
      staff_name: 'Winfred Asiimwe',
      staff_email: 'winnie@welile.com',
      staff_roles: ['landlord_ops'],
      questions_today: 42,
      max_questions_per_day: 50,
      questions_remaining: 8,
      budget_utilization_pct: 84,
      emails_today: 1,
      max_emails_per_day: 30,
      emails_remaining: 29,
      thumbs_down_today: 0,
      unanswered_today: 1,
      last_active_at: '2026-10-26T07:45:00Z',
    },
  ],
};

const SAMPLE_THREAD: ZoeCrmThreadMessage[] = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'Which Rent Plans are waiting on Landlord Ops?',
    tool_calls: [],
    tool_results_summary: [],
    sources: [],
    latency_ms: null,
    model: null,
    error_code: null,
    created_at: '2026-10-26T07:29:00Z',
    feedback_rating: null,
    feedback_comment: null,
    unanswered_reason: null,
    unanswered_status: null,
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content: null,
    content_redacted: true,
    outcome: 'answered',
    tools_called: ['assistant_staff_tops_pipeline_waiting_on_lops'],
    source_label: 'Tenant Ops Pipeline',
    period_label: '2026-10-01 to 2026-10-26',
    tool_calls: [{ name: 'assistant_staff_tops_pipeline_waiting_on_lops' }],
    tool_results_summary: [
      {
        name: 'assistant_staff_tops_pipeline_waiting_on_lops',
        source: 'Tenant Ops Pipeline',
        period: '2026-10-01 to 2026-10-26',
      },
    ],
    sources: [
      {
        tool: 'assistant_staff_tops_pipeline_waiting_on_lops',
        source: 'Tenant Ops Pipeline',
        period: '2026-10-01 to 2026-10-26',
      },
    ],
    latency_ms: 420,
    model: 'google/gemini-3-flash-preview',
    error_code: null,
    created_at: '2026-10-26T07:30:00Z',
    feedback_rating: -1,
    feedback_comment: 'Expected filtered by Wakiso only',
    unanswered_reason: null,
    unanswered_status: null,
  },
];

describe('ZoeConversationsPanel & useZoeCrm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseZoeCrmDashboard.mockReturnValue({
      data: SAMPLE_DASHBOARD,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    mockUseZoeCrmThread.mockReturnValue({
      data: SAMPLE_THREAD,
      isLoading: false,
    });
  });

  describe('Role-based access control (CRM reviewers only)', () => {
    it('allows the exact same CRM reviewer roles that review agent assistant chats today', () => {
      expect(ZOE_CRM_REVIEWER_ROLES).toEqual([
        'crm',
        'cto',
        'manager',
        'coo',
        'ceo',
        'super_admin',
      ]);

      for (const reviewerRole of ZOE_CRM_REVIEWER_ROLES) {
        expect(canReviewZoeConversations([reviewerRole])).toBe(true);
      }

      for (const nonReviewer of [
        'tenant_ops',
        'landlord_ops',
        'partner_ops',
        'agent_ops',
        'fin_ops',
        'hr',
        'operations',
        'employee',
        'agent',
        'tenant',
        'supporter',
      ]) {
        expect(canReviewZoeConversations([nonReviewer])).toBe(false);
      }
      expect(canReviewZoeConversations([])).toBe(false);
      expect(canReviewZoeConversations(null)).toBe(false);
    });

    it('refuses non-CRM-reviewer roles and does not enable dashboard fetching', () => {
      mockUseAuth.mockReturnValue({ roles: ['tenant_ops', 'employee'] });

      render(<ZoeConversationsPanel />);

      expect(screen.getByTestId('zoe-crm-access-denied')).toBeInTheDocument();
      expect(
        screen.getByText(/CRM Reviewer Access Required/i),
      ).toBeInTheDocument();
      expect(mockUseZoeCrmDashboard).toHaveBeenCalledWith(
        expect.anything(),
        false,
      );
    });

    it('opens the panel for CRM reviewers', () => {
      mockUseAuth.mockReturnValue({ roles: ['crm'] });

      render(<ZoeConversationsPanel />);

      expect(screen.getByTestId('zoe-conversations-panel')).toBeInTheDocument();
      expect(mockUseZoeCrmDashboard).toHaveBeenCalledWith(
        expect.anything(),
        true,
      );
      expect(screen.getByTestId('zoe-kpi-total-conversations')).toHaveTextContent(
        '3',
      );
      expect(screen.getByTestId('zoe-kpi-thumbs-down')).toHaveTextContent('1');
      expect(screen.getByTestId('zoe-kpi-unanswered')).toHaveTextContent('1');
    });
  });

  describe('Filters for role, thumbs-down, and "Zoe could not answer"', () => {
    it('filters conversations by role, thumbs-down, and unanswered status via pure helper and UI buttons', () => {
      expect(
        filterZoeConversations(SAMPLE_CONVERSATIONS, {
          roleFilter: 'tenant_ops',
        }).map((c) => c.id),
      ).toEqual(['conv-tops-1']);

      expect(
        filterZoeConversations(SAMPLE_CONVERSATIONS, {
          onlyThumbsDown: true,
        }).map((c) => c.id),
      ).toEqual(['conv-tops-1']);

      expect(
        filterZoeConversations(SAMPLE_CONVERSATIONS, {
          onlyUnanswered: true,
        }).map((c) => c.id),
      ).toEqual(['conv-lops-2']);

      mockUseAuth.mockReturnValue({ roles: ['crm'] });
      render(<ZoeConversationsPanel />);

      // Initially all 3 conversations are visible
      expect(
        screen.getByTestId('zoe-conversation-card-conv-tops-1'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('zoe-conversation-card-conv-lops-2'),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId('zoe-conversation-card-conv-cfo-3'),
      ).toBeInTheDocument();

      // Toggle Thumbs-down filter
      fireEvent.click(screen.getByTestId('zoe-filter-thumbs-down'));
      expect(
        screen.getByTestId('zoe-conversation-card-conv-tops-1'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('zoe-conversation-card-conv-lops-2'),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByTestId('zoe-conversation-card-conv-cfo-3'),
      ).not.toBeInTheDocument();

      // Reset and toggle "Zoe could not answer" filter
      fireEvent.click(screen.getByTestId('zoe-filter-clear'));
      fireEvent.click(screen.getByTestId('zoe-filter-unanswered'));
      expect(
        screen.getByTestId('zoe-conversation-card-conv-lops-2'),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId('zoe-conversation-card-conv-tops-1'),
      ).not.toBeInTheDocument();
    });
  });

  describe('Weekly summary of most-asked unanswered questions & daily usage against budget', () => {
    it('computes budget utilization percentages accurately against staff_assistant_config', () => {
      expect(computeBudgetUtilizationPct(12, 50)).toBe(24);
      expect(computeBudgetUtilizationPct(42, 50)).toBe(84);
      expect(computeBudgetUtilizationPct(60, 50)).toBe(100);
      expect(computeBudgetUtilizationPct(0, 50)).toBe(0);
    });

    it('renders the weekly unanswered summary and daily usage per person against staff_assistant_config', () => {
      mockUseAuth.mockReturnValue({ roles: ['coo'] });
      render(<ZoeConversationsPanel />);

      // Verify config badge shows budget from staff_assistant_config
      expect(
        screen.getByText(/50 questions\/day · 30 emails\/day/i),
      ).toBeInTheDocument();

      // Verify tabs show counts for weekly unanswered and daily usage
      expect(
        screen.getByTestId('zoe-tab-weekly-unanswered'),
      ).toHaveTextContent('Weekly Unanswered Summary (2)');
      expect(screen.getByTestId('zoe-tab-daily-usage')).toHaveTextContent(
        'Daily Usage vs Budget (2)',
      );
    });

    it('opens the conversation thread sheet when a conversation card is clicked', () => {
      mockUseAuth.mockReturnValue({ roles: ['crm'] });
      render(<ZoeConversationsPanel />);

      fireEvent.click(screen.getByTestId('zoe-conversation-card-conv-tops-1'));

      expect(screen.getByTestId('zoe-conversation-thread')).toBeInTheDocument();
      expect(screen.getByTestId('zoe-thread-message-msg-1')).toHaveTextContent(
        'Which Rent Plans are waiting on Landlord Ops?',
      );
      expect(screen.getByTestId('zoe-thread-message-msg-2')).toHaveTextContent(
        'Thumbs-down: Expected filtered by Wakiso only',
      );
      expect(screen.getByTestId('zoe-thread-redacted-msg-2')).toHaveTextContent(
        'Answer text & report figures redacted for role privacy',
      );
    });

    it('ensures a CRM reviewer cannot read a CFO answer text, report_payload, or figures', () => {
      const cfoThread: ZoeCrmThreadMessage[] = [
        {
          id: 'cfo-msg-1',
          role: 'user',
          content: 'What is our cash position today?',
          tool_calls: [],
          tool_results_summary: [],
          sources: [],
          latency_ms: null,
          model: null,
          error_code: null,
          created_at: '2026-10-26T07:49:00Z',
          feedback_rating: null,
          feedback_comment: null,
          unanswered_reason: null,
          unanswered_status: null,
        },
        {
          id: 'cfo-msg-2',
          role: 'assistant',
          // Even if a rogue payload ever contained text, the CRM thread view renders metadata only
          content: 'Total cash position is UGX 148,500,000.',
          content_redacted: true,
          outcome: 'answered',
          tools_called: ['get_cfo_treasury_cash_position'],
          source_label: 'Treasury Cash Position',
          period_label: '2026-10-26',
          tool_calls: [{ name: 'get_cfo_treasury_cash_position' }],
          tool_results_summary: [
            {
              name: 'get_cfo_treasury_cash_position',
              source: 'Treasury Cash Position',
              period: '2026-10-26',
            },
          ],
          sources: [
            {
              tool: 'get_cfo_treasury_cash_position',
              source: 'Treasury Cash Position',
              period: '2026-10-26',
            },
          ],
          latency_ms: 350,
          model: 'google/gemini-3-flash-preview',
          error_code: null,
          created_at: '2026-10-26T07:50:00Z',
          feedback_rating: 1,
          feedback_comment: 'Matched CFO screen',
          unanswered_reason: null,
          unanswered_status: null,
        },
      ];
      mockUseZoeCrmThread.mockReturnValue({
        data: cfoThread,
        isLoading: false,
      });
      mockUseAuth.mockReturnValue({ roles: ['crm'] });

      render(<ZoeConversationsPanel />);

      fireEvent.click(screen.getByTestId('zoe-conversation-card-conv-cfo-3'));

      const threadEl = screen.getByTestId('zoe-conversation-thread');
      // Reviewer sees question, time, role, tool names, outcome, thumbs and comment
      expect(threadEl).toHaveTextContent('What is our cash position today?');
      expect(threadEl).toHaveTextContent('Outcome: answered');
      expect(threadEl).toHaveTextContent('get_cfo_treasury_cash_position');
      expect(threadEl).toHaveTextContent('Helpful: Matched CFO screen');
      // Reviewer NEVER sees the CFO answer or figures
      expect(threadEl).not.toHaveTextContent('UGX 148,500,000');
      expect(threadEl).not.toHaveTextContent('Total cash position is');
    });
  });
});
