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

export interface ZoeModelDriftSummary {
  ok: boolean;
  source: string;
  sample_limit: number;
  checked_count: number;
  mismatched_count: number;
  drift_detected: boolean;
  configured_model_fast: string;
  configured_model_deep: string;
  dominant_gateway_model: string | null;
  observed_models: Array<{
    gateway_model: string;
    requested_model: string;
    reply_count: number;
    matches_config: boolean;
    last_seen_at: string;
  }>;
  warning_message: string | null;
}

export interface ZoeWeeklyAdoptionTrendPoint {
  week_start: string;
  week_end: string;
  week_label: string;
  distinct_staff_count: number;
  questions_count: number;
}

export interface ZoeRealUseDashboardData {
  ok: boolean;
  source: string;
  days: number;
  daily_active_staff: number;
  weekly_active_staff: number;
  baseline_weekly_active_staff?: number;
  weekly_adoption_trend?: ZoeWeeklyAdoptionTrendPoint[];
  questions_per_role: Array<{
    role_bucket: string;
    questions_count: number;
    answered_count: number;
    error_count: number;
    thumbs_up_count: number;
    thumbs_down_count: number;
  }>;
  answer_rate_pct: number;
  error_rate_pct: number;
  thumbs_up_rate_pct: number;
  median_ttfb_ms: number;
  p95_ttfb_ms: number;
  median_total_ms: number;
  p95_total_ms: number;
  cost_per_day_usd: Array<{
    day_kampala: string;
    questions_count: number;
    cost_usd: number;
  }>;
  top_unanswered_themes: Array<{
    topic: string;
    outcome: string;
    count: number;
  }>;
  model_drift?: ZoeModelDriftSummary | null;
  role_goals?: {
    disclaimer: string;
    role_goals: Array<{
      role: string;
      goal_label: string;
      official_source: string;
      zoe_adoption_note: string;
    }>;
  };
  error?: string | null;
}

export function useZoeModelDriftCheck(limit = 50, enabled = true) {
  const safeLimit = Math.min(200, Math.max(1, Math.floor(limit)));

  return useQuery({
    queryKey: ['zoe-model-drift-check', safeLimit],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ZoeModelDriftSummary | null> => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_check_model_drift',
        { p_limit: safeLimit },
      );

      if (error || !data || typeof data !== 'object') {
        return null;
      }

      const payload = data as Partial<ZoeModelDriftSummary>;
      return {
        ok: payload.ok !== false,
        source: payload.source ?? 'staff_assistant_check_model_drift',
        sample_limit: Number(payload.sample_limit ?? safeLimit),
        checked_count: Number(payload.checked_count ?? 0),
        mismatched_count: Number(payload.mismatched_count ?? 0),
        drift_detected: Boolean(payload.drift_detected),
        configured_model_fast: String(payload.configured_model_fast ?? ''),
        configured_model_deep: String(payload.configured_model_deep ?? ''),
        dominant_gateway_model:
          typeof payload.dominant_gateway_model === 'string'
            ? payload.dominant_gateway_model
            : null,
        observed_models: Array.isArray(payload.observed_models)
          ? payload.observed_models
          : [],
        warning_message:
          typeof payload.warning_message === 'string'
            ? payload.warning_message
            : null,
      };
    },
  });
}

export function useZoeRealUseDashboard(days = 14, enabled = true) {
  const safeDays = Math.min(90, Math.max(1, Math.floor(days)));

  return useQuery({
    queryKey: ['zoe-real-use-dashboard', safeDays],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ZoeRealUseDashboardData> => {
      const supabase = await getSupabaseClient();
      const callRpc = supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;

      const [dashRes, goalsRes] = await Promise.all([
        callRpc('staff_assistant_real_use_dashboard', { p_days: safeDays }),
        callRpc('staff_assistant_role_goals_and_measures', { p_days: 28 }),
      ]);

      if (dashRes.error) {
        return {
          ok: false,
          source: 'staff_assistant_real_use_dashboard',
          days: safeDays,
          daily_active_staff: 0,
          weekly_active_staff: 0,
          baseline_weekly_active_staff: 1,
          weekly_adoption_trend: [],
          questions_per_role: [],
          answer_rate_pct: 0,
          error_rate_pct: 0,
          thumbs_up_rate_pct: 0,
          median_ttfb_ms: 0,
          p95_ttfb_ms: 0,
          median_total_ms: 0,
          p95_total_ms: 0,
          cost_per_day_usd: [],
          top_unanswered_themes: [],
          error: dashRes.error.message,
        };
      }

      const payload = (dashRes.data ?? {}) as Partial<ZoeRealUseDashboardData>;
      const goalsPayload = (goalsRes.data ?? {}) as {
        disclaimer?: string;
        role_goals?: Array<{
          role: string;
          goal_label: string;
          official_source: string;
          zoe_adoption_note: string;
        }>;
      };

      return {
        ok: payload.ok !== false,
        source: payload.source ?? 'staff_assistant_real_use_dashboard',
        days: typeof payload.days === 'number' ? payload.days : safeDays,
        daily_active_staff: Number(payload.daily_active_staff ?? 0),
        weekly_active_staff: Number(payload.weekly_active_staff ?? 0),
        baseline_weekly_active_staff: Number(payload.baseline_weekly_active_staff ?? 1),
        weekly_adoption_trend: Array.isArray(payload.weekly_adoption_trend)
          ? payload.weekly_adoption_trend.map((pt) => ({
              week_start: String(pt.week_start ?? ''),
              week_end: String(pt.week_end ?? ''),
              week_label: String(pt.week_label ?? ''),
              distinct_staff_count: Number(pt.distinct_staff_count ?? 0),
              questions_count: Number(pt.questions_count ?? 0),
            }))
          : [],
        questions_per_role: Array.isArray(payload.questions_per_role)
          ? payload.questions_per_role
          : [],
        answer_rate_pct: Number(payload.answer_rate_pct ?? 0),
        error_rate_pct: Number(payload.error_rate_pct ?? 0),
        thumbs_up_rate_pct: Number(payload.thumbs_up_rate_pct ?? 0),
        median_ttfb_ms: Number(payload.median_ttfb_ms ?? 0),
        p95_ttfb_ms: Number(payload.p95_ttfb_ms ?? 0),
        median_total_ms: Number(payload.median_total_ms ?? 0),
        p95_total_ms: Number(payload.p95_total_ms ?? 0),
        cost_per_day_usd: Array.isArray(payload.cost_per_day_usd)
          ? payload.cost_per_day_usd
          : [],
        top_unanswered_themes: Array.isArray(payload.top_unanswered_themes)
          ? payload.top_unanswered_themes
          : [],
        model_drift:
          payload.model_drift && typeof payload.model_drift === 'object'
            ? (payload.model_drift as ZoeModelDriftSummary)
            : null,
        role_goals: {
          disclaimer:
            goalsPayload.disclaimer ??
            'Descriptive trend only — shows role goal figures alongside Zoe adoption for context, never a causal claim.',
          role_goals: Array.isArray(goalsPayload.role_goals)
            ? goalsPayload.role_goals
            : [],
        },
        error: null,
      };
    },
  });
}

export interface ZoeDepartmentTeachingQueueItem {
  id: string;
  department: string;
  source_kind: string;
  question_text: string;
  reason_or_comment: string | null;
  status: string;
  approved_answer: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  review_due_at: string | null;
  knowledge_id: string | null;
  created_at: string;
}

export function useZoeTeachingQueue(
  department: string | null = null,
  status = 'open',
  enabled = true,
) {
  return useQuery({
    queryKey: ['zoe-teaching-queue', department, status],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<ZoeDepartmentTeachingQueueItem[]> => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_department_teaching_queue',
        {
          p_department: department && department !== 'all' ? department : null,
          p_status: status,
          p_limit: 50,
        },
      );

      if (error) {
        return [];
      }

      const payload = (data ?? {}) as {
        items?: ZoeDepartmentTeachingQueueItem[];
      };
      return Array.isArray(payload.items) ? payload.items : [];
    },
  });
}

export function useTeachZoeFromQueue() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      queue_id: string;
      approved_answer: string;
      approved_by_name: string;
      title?: string;
      department?: string;
    }) => {
      const supabase = await getSupabaseClient();
      const { data, error } = await (supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>)(
        'staff_assistant_teach_from_review_queue',
        {
          p_unanswered_id: params.queue_id,
          p_title: params.title ?? 'Taught Knowledge Entry',
          p_category: 'faq',
          p_department: params.department ?? 'general',
          p_summary: params.approved_answer,
          p_body: params.approved_answer,
          p_official_source: 'Department Lead Teaching Queue',
        },
      );

      if (error) {
        throw new Error(error.message);
      }
      const res = (data ?? {}) as { ok?: boolean; error?: string };
      if (res.ok === false) {
        throw new Error(res.error || 'Could not approve teaching answer.');
      }
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['zoe-teaching-queue'] });
      qc.invalidateQueries({ queryKey: ['zoe-weekly-learning-view'] });
      qc.invalidateQueries({ queryKey: ['zoe-crm-dashboard'] });
    },
  });
}
