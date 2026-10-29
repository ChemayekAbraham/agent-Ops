import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ZoeChatSurface } from '../ZoeChatSurface';
import { ZoeWeeklyLookAtCard } from '../ZoeWeeklyLookAtCard';
import type { ZoeMessage } from '../useZoeAssistant';
import type {
  ZoeIdeasListResponse,
  ZoeMorningBriefPayload,
  ZoeWeeklyLookAtSummary,
} from '@/lib/zoe';

describe('Zoe Action Drafts, Schedules & Reminders List, and 07:30 Morning Brief', () => {
  it('renders a reminder draft card without saving until Save Reminder is clicked', async () => {
    const onConfirmReminder = vi.fn().mockResolvedValue({ ok: true });
    const messages: ZoeMessage[] = [
      {
        id: 'msg-rem-1',
        role: 'assistant',
        content: 'I have prepared a reminder draft for you. Source: My Space Reminder Draft · Period: 2026-10-27 09:00 EAT',
        source: 'My Space Reminder Draft',
        period: '2026-10-27 09:00 EAT',
        reportPayload: {
          action_draft: {
            draft_id: 'rem-1',
            action_type: 'reminder',
            status: 'ready',
            title: 'Follow up on Rent Plan approvals',
            remind_at: '2026-10-27T06:00:00.000Z',
            remind_at_kampala_label: '2026-10-27 09:00 EAT',
            note: 'Check landlord verifications',
          },
        },
      },
    ];

    render(
      <MemoryRouter>
        <ZoeChatSurface
          messages={messages}
          isLoading={false}
          onSendMessage={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
          onConfirmReminder={onConfirmReminder}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-action-draft-card-reminder')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-reminder-title')).toHaveTextContent(
      'Follow up on Rent Plan approvals',
    );
    expect(onConfirmReminder).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('zoe-action-draft-confirm-reminder'));

    await waitFor(() => {
      expect(onConfirmReminder).toHaveBeenCalledTimes(1);
    });
    expect(onConfirmReminder).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Follow up on Rent Plan approvals',
        remind_at: '2026-10-27T06:00:00.000Z',
        note: 'Check landlord verifications',
      }),
    );
    expect(await screen.findByTestId('zoe-action-draft-confirmed-reminder')).toBeInTheDocument();
  });

  it('requires picking a staff colleague when multiple staff match a notification draft, then sends on click', async () => {
    const onConfirmNotification = vi.fn().mockResolvedValue({ ok: true });
    const messages: ZoeMessage[] = [
      {
        id: 'msg-notif-1',
        role: 'assistant',
        content: 'Several colleagues matched. Please pick one on the draft card. Source: staff_assistant_email_recipients · Period: Current',
        source: 'staff_assistant_email_recipients',
        period: 'Current',
        reportPayload: {
          action_draft: {
            draft_id: 'notif-1',
            action_type: 'notification',
            status: 'pick_recipient',
            recipient_user_id: null,
            recipient_name: null,
            recipient_email: null,
            recipient_roles: [],
            title: 'Rent Plan pipeline review ready',
            message: 'Please check the Landlord Ops queue before 14:00 EAT.',
            candidates: [
              {
                staff_user_id: 'u-1',
                full_name: 'Jane Gimono',
                email: 'jane@welile.com',
                roles: ['operations'],
              },
              {
                staff_user_id: 'u-2',
                full_name: 'Winnie Asiimwe',
                email: 'winnie@welile.com',
                roles: ['operations'],
              },
            ],
          },
        },
      },
    ];

    render(
      <MemoryRouter>
        <ZoeChatSurface
          messages={messages}
          isLoading={false}
          onSendMessage={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
          onConfirmNotification={onConfirmNotification}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-action-draft-card-notification')).toBeInTheDocument();
    const sendBtn = screen.getByTestId('zoe-action-draft-confirm-notification');
    expect(sendBtn).toBeDisabled();
    expect(onConfirmNotification).not.toHaveBeenCalled();

    // Pick Jane
    fireEvent.click(screen.getByTestId('zoe-notif-candidate-jane@welile.com'));
    expect(sendBtn).not.toBeDisabled();

    fireEvent.click(sendBtn);

    await waitFor(() => {
      expect(onConfirmNotification).toHaveBeenCalledTimes(1);
    });
    expect(onConfirmNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipient_email: 'jane@welile.com',
        title: 'Rent Plan pipeline review ready',
        message: 'Please check the Landlord Ops queue before 14:00 EAT.',
      }),
    );
    expect(
      await screen.findByTestId('zoe-action-draft-confirmed-notification'),
    ).toBeInTheDocument();
  });

  it('renders a recurring report schedule draft card and saves only when Save Schedule is clicked', async () => {
    const onConfirmSchedule = vi.fn().mockResolvedValue({ ok: true });
    const messages: ZoeMessage[] = [
      {
        id: 'msg-sched-1',
        role: 'assistant',
        content: 'I have prepared your weekly schedule draft. Source: get_treasury_cash_position · Period: 2026-10-26',
        source: 'get_treasury_cash_position',
        period: '2026-10-26',
        reportPayload: {
          action_draft: {
            draft_id: 'sched-1',
            action_type: 'schedule',
            status: 'ready',
            title: 'Weekly Treasury Cash Position Report',
            report_tool: 'cfo_treasury_cash_position',
            report_rpc: 'assistant_staff_cfo_treasury_cash_position',
            report_args: {},
            source: 'get_treasury_cash_position',
            period: '2026-10-26',
            frequency: 'weekly',
            day_of_week: 1,
            day_of_week_label: 'Monday',
            send_time_kampala: '07:30',
            recipient_emails: ['cfo@welile.com'],
            recipient_names: ['CFO Office'],
            custom_message: 'Automated weekly treasury report from Zoe.',
            candidates: [
              {
                staff_user_id: 'u-cfo',
                full_name: 'CFO Office',
                email: 'cfo@welile.com',
                roles: ['cfo'],
              },
            ],
          },
        },
      },
    ];

    render(
      <MemoryRouter>
        <ZoeChatSurface
          messages={messages}
          isLoading={false}
          onSendMessage={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
          onConfirmSchedule={onConfirmSchedule}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-action-draft-card-schedule')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-schedule-cadence')).toHaveTextContent(
      'Weekly on Monday at 07:30 EAT',
    );
    expect(onConfirmSchedule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('zoe-action-draft-confirm-schedule'));

    await waitFor(() => {
      expect(onConfirmSchedule).toHaveBeenCalledTimes(1);
    });
    expect(onConfirmSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Weekly Treasury Cash Position Report',
        report_tool: 'cfo_treasury_cash_position',
        report_rpc: 'assistant_staff_cfo_treasury_cash_position',
        frequency: 'weekly',
        recipient_emails: ['cfo@welile.com'],
        day_of_week: 1,
        send_time_kampala: '07:30',
      }),
    );
    expect(await screen.findByTestId('zoe-action-draft-confirmed-schedule')).toBeInTheDocument();
  });

  it('lists active reminders and schedules and lets the person cancel each item from Zoe', async () => {
    const onCancelReminder = vi.fn().mockResolvedValue({ ok: true });
    const onCancelSchedule = vi.fn().mockResolvedValue({ ok: true });

    const messages: ZoeMessage[] = [
      {
        id: 'msg-list-1',
        role: 'assistant',
        content: 'Here are your active reminders and scheduled report emails.',
        source: 'staff_assistant_reminders + staff_assistant_schedules',
        period: 'As of 2026-10-26',
        reportPayload: {
          tool: 'get_my_reminders_and_schedules',
          source: 'staff_assistant_reminders + staff_assistant_schedules',
          period: 'As of 2026-10-26',
          morning_brief_enabled: true,
          morning_brief_time_kampala: '07:30',
          reminders: [
            {
              id: 'rem-uuid-1',
              title: 'Check Rent Plan verifications',
              note: 'Before lunch',
              remind_at: '2026-10-26T09:00:00Z',
              status: 'pending',
              created_at: '2026-10-26T06:00:00Z',
            },
          ],
          schedules: [
            {
              id: 'sched-uuid-1',
              title: 'Daily Tenant Ops Summary',
              report_tool: 'tenant_ops_overview',
              report_rpc: 'assistant_staff_tenant_ops_overview',
              frequency: 'daily',
              day_of_week: null,
              send_time_kampala: '07:30',
              recipient_emails: ['ops@welile.com'],
              recipient_names: ['Tenant Ops'],
              custom_message: null,
              is_active: true,
              next_run_at: '2026-10-27T04:30:00Z',
              last_run_at: null,
              last_run_status: null,
            },
          ],
        },
      },
    ];

    render(
      <MemoryRouter>
        <ZoeChatSurface
          messages={messages}
          isLoading={false}
          onSendMessage={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
          onCancelReminder={onCancelReminder}
          onCancelSchedule={onCancelSchedule}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-schedules-and-reminders-card')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-reminder-item-rem-uuid-1')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-schedule-item-sched-uuid-1')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('zoe-cancel-reminder-rem-uuid-1'));
    await waitFor(() => {
      expect(onCancelReminder).toHaveBeenCalledWith('rem-uuid-1');
    });
    expect(screen.queryByTestId('zoe-reminder-item-rem-uuid-1')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('zoe-cancel-schedule-sched-uuid-1'));
    await waitFor(() => {
      expect(onCancelSchedule).toHaveBeenCalledWith('sched-uuid-1');
    });
    expect(screen.queryByTestId('zoe-schedule-item-sched-uuid-1')).not.toBeInTheDocument();
  });

  it('displays the optional 07:30 Kampala Morning Brief (off by default, turned on per person) with assistant_staff_* sources', async () => {
    const onUpdateMorningBriefPrefs = vi.fn().mockResolvedValue({ ok: true });
    const enabledBrief: ZoeMorningBriefPayload = {
      available: true,
      enabled: true,
      should_display_now: true,
      kampala_date: '2026-10-26',
      scheduled_time_kampala: '07:30',
      headline: 'Good morning · Your 07:30 Kampala Morning Brief for 2026-10-26',
      source: 'assistant_staff_my_reminders_and_schedules + assistant_staff_cfo_treasury_cash_position',
      period: '2026-10-26 (07:30 EAT)',
      sections: [
        {
          tool: 'get_my_reminders_and_schedules',
          rpc: 'assistant_staff_my_reminders_and_schedules',
          title: 'My Reminders & Scheduled Reports',
          source: 'staff_assistant_reminders + staff_assistant_schedules',
          period: 'As of 2026-10-26',
          summary: '1 active reminder · 1 scheduled report email.',
          row_count: 2,
        },
        {
          tool: 'cfo_treasury_cash_position',
          rpc: 'assistant_staff_cfo_treasury_cash_position',
          title: 'Treasury Cash Position',
          source: 'get_treasury_cash_position',
          period: '2026-10-26',
          summary: 'Total cash: UGX 48,500,000 across 3 accounts.',
          row_count: 3,
        },
      ],
    };

    const onRefreshMorningBrief = vi.fn().mockResolvedValue(enabledBrief);

    const disabledBrief: ZoeMorningBriefPayload = {
      ...enabledBrief,
      enabled: false,
      should_display_now: false,
      headline: 'Morning Brief is off by default (07:30 Kampala time). Turn it on to see your daily summary here.',
      sections: [],
    };

    render(
      <MemoryRouter>
        <ZoeChatSurface
          messages={[]}
          morningBrief={disabledBrief}
          isLoading={false}
          onSendMessage={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
          onUpdateMorningBriefPrefs={onUpdateMorningBriefPrefs}
          onRefreshMorningBrief={onRefreshMorningBrief}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-morning-brief-card')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-morning-brief-toggle')).toHaveTextContent(
      'Turn on 07:30 brief',
    );
    expect(screen.queryByTestId('zoe-morning-brief-sections')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('zoe-morning-brief-toggle'));

    await waitFor(() => {
      expect(onUpdateMorningBriefPrefs).toHaveBeenCalledWith({
        enabled: true,
        brief_time: '07:30',
      });
    });

    expect(await screen.findByTestId('zoe-morning-brief-sections')).toBeInTheDocument();
    expect(
      screen.getByTestId('zoe-brief-section-cfo_treasury_cash_position'),
    ).toHaveTextContent('Total cash: UGX 48,500,000 across 3 accounts.');
    expect(
      screen.getByTestId('zoe-brief-source-cfo_treasury_cash_position'),
    ).toHaveTextContent('Source: get_treasury_cash_position · 2026-10-26');
  });

  it('renders an Idea for Welile draft card and saves only when Save Idea is clicked', async () => {
    const onConfirmIdea = vi.fn().mockResolvedValue({ ok: true });
    const messages: ZoeMessage[] = [
      {
        id: 'msg-idea-1',
        role: 'assistant',
        content:
          'Landlord Ops wait times averaged 18.5 hours across 64 requests. Click Save Idea if you would like to add this suggestion to Ideas for Welile. Source: rent_request_timing · Period: Last 4 weeks',
        source: 'rent_request_timing',
        period: 'Last 4 weeks',
        reportPayload: {
          action_draft: {
            draft_id: 'idea-draft-99',
            action_type: 'idea',
            status: 'ready',
            title: 'Add 10:00 EAT Landlord Ops verification cut-off',
            suggestion:
              'Review the Landlord Ops verification queue at 10:00 EAT and 15:00 EAT daily to reduce wait times.',
            evidence_summary:
              'Landlord Ops desk wait averaged 18.5 hours across 64 requests over the last 4 weeks.',
            figures: { avg_wait_hours: 18.5, requests_count: 64 },
            source_label: 'rent_request_timing',
            period_label: 'Last 4 weeks',
            category: 'desk_wait',
            screen_path: '/coo-dashboard',
          },
        },
      },
    ];

    render(
      <MemoryRouter>
        <ZoeChatSurface
          messages={messages}
          activeConversationId="conv-1"
          isLoading={false}
          onSendMessage={vi.fn()}
          onFeedback={vi.fn()}
          onClearHistory={vi.fn()}
          onConfirmIdea={onConfirmIdea}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId('zoe-action-draft-card-idea')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-idea-title')).toHaveTextContent(
      'Add 10:00 EAT Landlord Ops verification cut-off',
    );
    expect(screen.getByTestId('zoe-idea-evidence')).toHaveTextContent('18.5 hours across 64 requests');
    expect(onConfirmIdea).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('zoe-action-draft-confirm-idea'));

    await waitFor(() => {
      expect(onConfirmIdea).toHaveBeenCalledTimes(1);
    });
    expect(onConfirmIdea).toHaveBeenCalledWith(
      expect.objectContaining({
        draft_id: 'idea-draft-99',
        rebind_draft: false,
        title: 'Add 10:00 EAT Landlord Ops verification cut-off',
        source_label: 'rent_request_timing',
        category: 'desk_wait',
        screen_path: '/coo-dashboard',
        conversation_id: 'conv-1',
        message_id: 'msg-idea-1',
      }),
    );
    expect(await screen.findByTestId('zoe-action-draft-confirmed-idea')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-idea-confirmed-link')).toHaveAttribute('href', '/me/ideas');
  });

  it('renders the Monday What to look at this week card for managers/COO/CEO and hides it for non-managers', () => {
    const queryClient = new QueryClient();
    const sampleWeekly: ZoeWeeklyLookAtSummary = {
      source: 'staff_assistant_weekly_look_at_summary',
      week_start: '2026-10-26',
      as_of: '2026-10-26',
      is_monday: true,
      in_app_only: true,
      new_ideas_count: 3,
      issues: [
        {
          rank: 1,
          category: 'desk_wait',
          title: 'Landlord Ops desk wait time is highest this week',
          evidence: 'Average wait is 18.5 hours across 64 Rent Plan requests.',
          metric_label: '18.5h avg wait',
          source: 'rent_request_timing',
          screen_path: '/coo-dashboard',
          screen_label: 'Open COO Dashboard',
        },
        {
          rank: 2,
          category: 'collections',
          title: 'Wakiso collection coverage dropped week on week',
          evidence: 'Coverage in Wakiso is 14% below its 4-week average.',
          metric_label: '-14% vs 4w avg',
          source: 'assistant_staff_insight_collection_coverage_trends',
          screen_path: '/tenant-ops/workspace',
          screen_label: 'Open Tenant Ops Workspace',
        },
        {
          rank: 3,
          category: 'calling',
          title: 'Calling Center reach rate needs follow-up on unreached numbers',
          evidence: 'Reach rate is 68% across 310 calls this week.',
          metric_label: '68% reach rate',
          source: 'staff_calling_detailed_report',
          screen_path: '/me/staff-reports',
          screen_label: 'Open Staff Reports',
        },
        {
          rank: 4,
          category: 'payouts',
          title: 'Funded Rent Plans awaiting landlord payout verification',
          evidence: '9 funded plans have waited more than 24 hours for payout.',
          metric_label: '9 plans >24h',
          source: 'am_uncovered_plans',
          screen_path: '/financial-ops',
          screen_label: 'Open Financial Ops',
        },
        {
          rank: 5,
          category: 'zoe_quality',
          title: 'Top unanswered Zoe questions from staff this week',
          evidence: '4 questions asked about regional sub-agent targets.',
          metric_label: '4 unanswered',
          source: 'staff_assistant_unanswered_questions',
          screen_path: '/crm/dashboard',
          screen_label: 'Open CRM Dashboard',
        },
      ],
      unanswered_questions: [
        {
          question: 'deliver the calling report for october',
          role: 'super_admin',
          outcome: 'error',
          ask_count: 1,
        },
        {
          question: 'regional sub-agent targets for wakiso',
          role: 'agent_ops',
          outcome: 'missing_tool',
          ask_count: 3,
        },
      ],
      feedback_summary: {
        thumbs_up_count: 24,
        thumbs_down_count: 2,
        problem_reports_count: 1,
      },
      anomaly_notes: [
        {
          category: 'desk_wait',
          title: 'Landlord Ops desk wait hours',
          summary: 'Wait time is +47% above its 4-week Kampala baseline.',
          source_function: 'rent_request_timing',
          period_label: 'Last 4 weeks',
        },
      ],
    };

    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ZoeWeeklyLookAtCard roles={['employee']} summary={sampleWeekly} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    // Non-manager sees nothing
    expect(screen.queryByTestId('zoe-weekly-look-at-card')).not.toBeInTheDocument();

    // COO / Manager sees the top 5 issues with evidence and screen links
    rerender(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ZoeWeeklyLookAtCard roles={['coo']} summary={sampleWeekly} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId('zoe-weekly-look-at-card')).toBeInTheDocument();
    expect(screen.getByText('What to look at this week')).toBeInTheDocument();
    expect(screen.getByText('In-app only')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-weekly-ideas-link')).toHaveTextContent('Ideas for Welile (3 new)');
    for (let rank = 1; rank <= 5; rank++) {
      expect(screen.getByTestId(`zoe-weekly-issue-${rank}`)).toBeInTheDocument();
      expect(screen.getByTestId(`zoe-weekly-issue-link-${rank}`)).toBeInTheDocument();
    }

    // Weekly redacted "Questions Zoe could not answer" table + feedback summary + anomaly notes
    expect(screen.getByTestId('zoe-weekly-unanswered-section')).toBeInTheDocument();
    expect(screen.getByTestId('zoe-weekly-unanswered-table')).toHaveTextContent(
      'deliver the calling report for october',
    );
    expect(screen.getByTestId('zoe-weekly-unanswered-table')).toHaveTextContent(
      'regional sub-agent targets for wakiso',
    );
    expect(screen.getByTestId('zoe-weekly-feedback-counts')).toHaveTextContent('Helpful: 24');
    expect(screen.getByTestId('zoe-weekly-feedback-counts')).toHaveTextContent('Not helpful: 2');
    expect(screen.getByTestId('zoe-weekly-feedback-counts')).toHaveTextContent(
      'Reported problems: 1',
    );
    expect(screen.getByTestId('zoe-weekly-anomaly-notes')).toHaveTextContent(
      'Landlord Ops desk wait hours',
    );
  });
});
