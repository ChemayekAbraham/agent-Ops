import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * The exact same roles that review Agent Assistant chats today
 * (matches `staff_assistant_is_crm_reviewer()` and `assistant_conversations` CRM RLS).
 */
export const ZOE_CRM_REVIEWER_ROLES = [
  'crm',
  'cto',
  'manager',
  'coo',
  'ceo',
  'super_admin',
] as const;

export type ZoeCrmReviewerRole = (typeof ZOE_CRM_REVIEWER_ROLES)[number];

export function canReviewZoeConversations(
  roles: readonly string[] | null | undefined,
): boolean {
  if (!roles || roles.length === 0) return false;
  const reviewerSet = new Set<string>(ZOE_CRM_REVIEWER_ROLES);
  return roles.some((r) => reviewerSet.has(r));
}

export interface ZoeCrmConfig {
  enabled: boolean;
  max_questions_per_day: number;
  max_emails_per_day: number;
  history_days: number;
}

export interface ZoeCrmSummary {
  total_conversations: number;
  conversations_with_thumbs_down: number;
  conversations_with_unanswered: number;
  open_unanswered_count: number;
  active_staff_today: number;
  questions_asked_today: number;
  emails_sent_today: number;
}

export interface ZoeCrmConversationRow {
  id: string;
  user_id: string;
  staff_name: string;
  staff_email: string;
  staff_phone: string;
  staff_roles: string[];
  title: string | null;
  last_message_at: string;
  created_at: string;
  session_context: Record<string, unknown> | null;
  message_count: number;
  assistant_count: number;
  thumbs_up_count: number;
  thumbs_down_count: number;
  unanswered_count: number;
  has_thumbs_down: boolean;
  has_unanswered: boolean;
  last_user_question: string | null;
  last_outcome?: string | null;
  last_tools_called?: string[];
}

export type ZoeUnansweredStatus = 'open' | 'reviewed' | 'planned' | 'dismissed';

export interface ZoeWeeklyUnansweredRow {
  normalized_question: string;
  question_text: string;
  ask_count: number;
  unique_staff_count: number;
  roles_asking: string[];
  latest_reason: string;
  latest_status: ZoeUnansweredStatus;
  latest_id: string;
  latest_review_note: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ZoeWeeklyThumbsDownRow {
  normalized_question: string;
  question_text: string;
  thumbs_down_count: number;
  unique_staff_count: number;
  latest_comment: string | null;
  latest_outcome: string | null;
  latest_source_label: string | null;
  tools_called: string[];
  latest_conversation_id: string;
  last_feedback_at: string;
  roles_reporting: string[];
  answer_redacted: boolean;
}

export interface ZoeDailyUsageRow {
  user_id: string;
  staff_name: string;
  staff_email: string;
  staff_roles: string[];
  questions_today: number;
  max_questions_per_day: number;
  questions_remaining: number;
  budget_utilization_pct: number;
  emails_today: number;
  max_emails_per_day: number;
  emails_remaining: number;
  thumbs_down_today: number;
  unanswered_today: number;
  last_active_at: string | null;
}

export interface ZoeErrorSummaryByCodeRow {
  error_code: string;
  total_count: number;
  unique_staff_count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export interface ZoeErrorSummaryByDayRow {
  day_kampala: string;
  error_code: string;
  error_count: number;
  unique_staff_count: number;
}

export interface ZoeErrorSummaryData {
  ok: boolean;
  source: string;
  days: number;
  from_date: string;
  to_date: string;
  total_errors: number;
  by_code: ZoeErrorSummaryByCodeRow[];
  by_day: ZoeErrorSummaryByDayRow[];
  error?: string | null;
}

export interface ZoeCrmDashboardData {
  generated_at: string;
  kampala_date: string;
  config: ZoeCrmConfig;
  summary: ZoeCrmSummary;
  available_roles: string[];
  conversations: ZoeCrmConversationRow[];
  weekly_unanswered_summary: ZoeWeeklyUnansweredRow[];
  weekly_thumbs_down_summary?: ZoeWeeklyThumbsDownRow[];
  daily_usage_per_person: ZoeDailyUsageRow[];
}

export interface ZoeCrmThreadMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** User question text for `role === 'user'`; always `null` (redacted) for `role === 'assistant'`. */
  content: string | null;
  content_redacted?: boolean;
  outcome?: string | null;
  tools_called?: string[];
  source_label?: string | null;
  period_label?: string | null;
  tool_calls: Array<{ name?: string }>;
  tool_results_summary: Array<{
    name?: string;
    source?: string;
    period?: string;
  }>;
  sources: Array<{
    tool?: string;
    source?: string;
    period?: string;
    href?: string;
  }>;
  latency_ms: number | null;
  model: string | null;
  error_code: string | null;
  created_at: string;
  feedback_rating: -1 | 1 | null;
  feedback_comment: string | null;
  unanswered_reason: string | null;
  unanswered_status: ZoeUnansweredStatus | null;
}

export interface ZoeCrmFilters {
  roleFilter?: string;
  onlyThumbsDown?: boolean;
  onlyUnanswered?: boolean;
  search?: string;
  limit?: number;
}

export function filterZoeConversations(
  conversations: readonly ZoeCrmConversationRow[],
  filters: ZoeCrmFilters,
): ZoeCrmConversationRow[] {
  const roleFilter = (filters.roleFilter ?? '').trim();
  const onlyThumbsDown = Boolean(filters.onlyThumbsDown);
  const onlyUnanswered = Boolean(filters.onlyUnanswered);
  const search = (filters.search ?? '').trim().toLowerCase();

  return conversations.filter((conv) => {
    if (roleFilter && roleFilter !== 'all') {
      if (!conv.staff_roles.includes(roleFilter)) {
        return false;
      }
    }
    if (onlyThumbsDown && !conv.has_thumbs_down && conv.thumbs_down_count <= 0) {
      return false;
    }
    if (onlyUnanswered && !conv.has_unanswered && conv.unanswered_count <= 0) {
      return false;
    }
    if (search) {
      const haystack = [
        conv.staff_name,
        conv.staff_email,
        conv.staff_phone,
        conv.title ?? '',
        conv.last_user_question ?? '',
        conv.last_outcome ?? '',
        ...(conv.last_tools_called ?? []),
        ...conv.staff_roles,
      ]
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(search)) {
        return false;
      }
    }
    return true;
  });
}

export function computeBudgetUtilizationPct(
  used: number,
  budget: number,
): number {
  if (!Number.isFinite(budget) || budget <= 0) return 0;
  const raw = Math.round((Math.max(0, used) / budget) * 1000) / 10;
  return Math.min(100, Math.max(0, raw));
}

async function getSupabaseClient() {
  const mod = await import('@/integrations/supabase/client');
  return mod.supabase;
}

export function useZoeCrmDashboard(filters: ZoeCrmFilters = {}, enabled = true) {
  const roleParam =
    filters.roleFilter && filters.roleFilter !== 'all' ? filters.roleFilter : null;
  const onlyThumbsDown = Boolean(filters.onlyThumbsDown);
  const onlyUnanswered = Boolean(filters.onlyUnanswered);
  const limit = filters.limit ?? 150;

  return useQuery({
    queryKey: [
      'zoe-crm-dashboard',
      roleParam,
      onlyThumbsDown,
      onlyUnanswered,
      limit,
    ],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ZoeCrmDashboardData> => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_crm_review_dashboard',
        {
          p_role_filter: roleParam,
          p_only_thumbs_down: onlyThumbsDown,
          p_only_unanswered: onlyUnanswered,
          p_limit: limit,
        },
      );

      if (error) {
        throw new Error(error.message);
      }

      const payload = (data ?? {}) as Partial<ZoeCrmDashboardData>;
      return {
        generated_at: payload.generated_at ?? new Date().toISOString(),
        kampala_date: payload.kampala_date ?? '',
        config: {
          enabled: payload.config?.enabled ?? true,
          max_questions_per_day: payload.config?.max_questions_per_day ?? 50,
          max_emails_per_day: payload.config?.max_emails_per_day ?? 30,
          history_days: payload.config?.history_days ?? 90,
        },
        summary: {
          total_conversations: payload.summary?.total_conversations ?? 0,
          conversations_with_thumbs_down:
            payload.summary?.conversations_with_thumbs_down ?? 0,
          conversations_with_unanswered:
            payload.summary?.conversations_with_unanswered ?? 0,
          open_unanswered_count: payload.summary?.open_unanswered_count ?? 0,
          active_staff_today: payload.summary?.active_staff_today ?? 0,
          questions_asked_today: payload.summary?.questions_asked_today ?? 0,
          emails_sent_today: payload.summary?.emails_sent_today ?? 0,
        },
        available_roles: Array.isArray(payload.available_roles)
          ? payload.available_roles
          : [],
        conversations: Array.isArray(payload.conversations)
          ? payload.conversations
          : [],
        weekly_unanswered_summary: Array.isArray(
          payload.weekly_unanswered_summary,
        )
          ? payload.weekly_unanswered_summary
          : [],
        weekly_thumbs_down_summary: Array.isArray(
          payload.weekly_thumbs_down_summary,
        )
          ? payload.weekly_thumbs_down_summary
          : [],
        daily_usage_per_person: Array.isArray(payload.daily_usage_per_person)
          ? payload.daily_usage_per_person
          : [],
      };
    },
  });
}

export function useZoeCrmThread(conversationId: string | null) {
  return useQuery({
    queryKey: ['zoe-crm-thread', conversationId],
    enabled: Boolean(conversationId),
    queryFn: async (): Promise<ZoeCrmThreadMessage[]> => {
      if (!conversationId) return [];
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_crm_conversation_thread',
        {
          p_conversation_id: conversationId,
        },
      );

      if (error) {
        throw new Error(error.message);
      }

      return Array.isArray(data) ? (data as ZoeCrmThreadMessage[]) : [];
    },
  });
}

export function useUpdateZoeUnanswered() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      id: string;
      status: ZoeUnansweredStatus;
      review_note?: string;
    }) => {
      const supabase = await getSupabaseClient();
      const { error } = await (supabase.from as unknown as (table: string) => {
        update: (values: Record<string, unknown>) => {
          eq: (
            col: string,
            val: string,
          ) => Promise<{ error: { message: string } | null }>;
        };
      })('staff_assistant_unanswered')
        .update({
          status: params.status,
          review_note: params.review_note ?? null,
        })
        .eq('id', params.id);

      if (error) {
        throw new Error(error.message);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['zoe-crm-dashboard'] });
    },
  });
}

export function useZoeErrorSummary(days = 14, enabled = true) {
  const safeDays = Math.min(90, Math.max(1, Math.floor(days)));

  return useQuery({
    queryKey: ['zoe-error-summary', safeDays],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ZoeErrorSummaryData> => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_error_summary',
        {
          p_days: safeDays,
        },
      );

      if (error) {
        return {
          ok: false,
          source: 'staff_assistant_error_summary',
          days: safeDays,
          from_date: '',
          to_date: '',
          total_errors: 0,
          by_code: [],
          by_day: [],
          error: error.message,
        };
      }

      const payload = (data ?? {}) as Partial<ZoeErrorSummaryData>;
      return {
        ok: payload.ok !== false,
        source: payload.source ?? 'staff_assistant_error_summary',
        days: typeof payload.days === 'number' ? payload.days : safeDays,
        from_date: payload.from_date ?? '',
        to_date: payload.to_date ?? '',
        total_errors:
          typeof payload.total_errors === 'number' ? payload.total_errors : 0,
        by_code: Array.isArray(payload.by_code) ? payload.by_code : [],
        by_day: Array.isArray(payload.by_day) ? payload.by_day : [],
        error: null,
      };
    },
  });
}

export interface ZoeWeeklyLearningTopicRow {
  topic: string;
  ask_count: number;
  answered_count: number;
  unanswered_count: number;
  thumbs_down_count: number;
  thumbs_up_count: number;
  avg_latency_ms: number;
  total_cost_usd: number;
}

export interface ZoeWeeklyUnansweredThemeRow {
  topic: string;
  outcome: string;
  count: number;
}

export interface ZoeWeeklyThumbsDownThemeRow {
  topic: string;
  feedback_theme: string;
  tool_used: string;
  count: number;
}

export interface ZoeWeeklyCostSummary {
  total_questions: number;
  total_cost_usd: number;
  avg_cost_usd: number;
  avg_latency_ms: number;
  thumbs_down_rate_pct: number;
}

export interface ZoeLearningReviewQueueItem {
  source_kind: 'feedback' | 'unanswered';
  source_id: string;
  message_id?: string | null;
  question_redacted: string;
  tool_used: string;
  outcome: string;
  comment_redacted: string | null;
  status: string;
  created_at: string;
}

export interface ZoeEvalCandidateItem {
  id: string;
  source_kind: string;
  source_id: string;
  cleaned_question: string;
  expected_tool: string | null;
  expected_topic: string | null;
  expected_outcome: string;
  review_status: string;
  notes: string | null;
  created_at: string;
}

export interface ZoeWeeklyLearningViewData {
  ok: boolean;
  source: string;
  days: number;
  no_individual_staff_text: boolean;
  top_topics: ZoeWeeklyLearningTopicRow[];
  unanswered_themes: ZoeWeeklyUnansweredThemeRow[];
  thumbs_down_themes: ZoeWeeklyThumbsDownThemeRow[];
  cost_summary: ZoeWeeklyCostSummary;
  review_queue: ZoeLearningReviewQueueItem[];
  eval_candidates: ZoeEvalCandidateItem[];
  error?: string | null;
}

export function useZoeWeeklyLearningView(days = 7, enabled = true) {
  const safeDays = Math.min(90, Math.max(1, Math.floor(days)));

  return useQuery({
    queryKey: ['zoe-weekly-learning-view', safeDays],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ZoeWeeklyLearningViewData> => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_weekly_manager_learning_view',
        { p_days: safeDays },
      );

      if (error) {
        return {
          ok: false,
          source: 'staff_assistant_weekly_manager_learning_view',
          days: safeDays,
          no_individual_staff_text: true,
          top_topics: [],
          unanswered_themes: [],
          thumbs_down_themes: [],
          cost_summary: {
            total_questions: 0,
            total_cost_usd: 0,
            avg_cost_usd: 0,
            avg_latency_ms: 0,
            thumbs_down_rate_pct: 0,
          },
          review_queue: [],
          eval_candidates: [],
          error: error.message,
        };
      }

      const payload = (data ?? {}) as Partial<ZoeWeeklyLearningViewData>;
      return {
        ok: payload.ok !== false,
        source: payload.source ?? 'staff_assistant_weekly_manager_learning_view',
        days: typeof payload.days === 'number' ? payload.days : safeDays,
        no_individual_staff_text: true,
        top_topics: Array.isArray(payload.top_topics) ? payload.top_topics : [],
        unanswered_themes: Array.isArray(payload.unanswered_themes)
          ? payload.unanswered_themes
          : [],
        thumbs_down_themes: Array.isArray(payload.thumbs_down_themes)
          ? payload.thumbs_down_themes
          : [],
        cost_summary: payload.cost_summary ?? {
          total_questions: 0,
          total_cost_usd: 0,
          avg_cost_usd: 0,
          avg_latency_ms: 0,
          thumbs_down_rate_pct: 0,
        },
        review_queue: Array.isArray(payload.review_queue)
          ? payload.review_queue
          : [],
        eval_candidates: Array.isArray(payload.eval_candidates)
          ? payload.eval_candidates
          : [],
        error: null,
      };
    },
  });
}

export function usePromoteZoeEvalCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      source_kind: 'feedback' | 'unanswered';
      source_id: string;
      cleaned_question?: string | null;
      expected_tool?: string | null;
      expected_topic?: string | null;
      notes?: string | null;
    }) => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_promote_to_eval_set',
        {
          p_source_kind: params.source_kind,
          p_source_id: params.source_id,
          p_cleaned_question: params.cleaned_question ?? null,
          p_expected_tool: params.expected_tool ?? null,
          p_expected_topic: params.expected_topic ?? null,
          p_notes: params.notes ?? null,
        },
      );

      if (error) {
        throw new Error(error.message);
      }
      const res = (data ?? {}) as { ok?: boolean; error?: string };
      if (res.ok === false) {
        throw new Error(res.error || 'Could not add item to evaluation set.');
      }
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['zoe-weekly-learning-view'] });
      qc.invalidateQueries({ queryKey: ['zoe-crm-dashboard'] });
    },
  });
}
