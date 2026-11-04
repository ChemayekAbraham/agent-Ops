import { useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  AlertCircle,
  Bot,
  Calendar,
  CheckCircle2,
  Clock,
  Filter,
  HelpCircle,
  Mail,
  MessageSquare,
  RefreshCw,
  Search,
  ShieldAlert,
  ThumbsDown,
  ThumbsUp,
  User,
  Users,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/hooks/useAuth';
import {
  canReviewZoeConversations,
  computeBudgetUtilizationPct,
  filterZoeConversations,
  usePromoteZoeEvalCandidate,
  useTeachZoeFromQueue,
  useUpdateZoeUnanswered,
  useZoeCrmDashboard,
  useZoeCrmThread,
  useZoeErrorSummary,
  useZoeRealUseDashboard,
  useZoeTeachingQueue,
  useZoeWeeklyLearningView,
  ZOE_CRM_REVIEWER_ROLES,
  type ZoeCrmConversationRow,
  type ZoeDepartmentTeachingQueueItem,
  type ZoeLearningReviewQueueItem,
  type ZoeUnansweredStatus,
  type ZoeWeeklyUnansweredRow,
} from '@/hooks/useZoeCrm';
import { toast } from 'sonner';

const ROLE_LABELS: Record<string, string> = {
  employee: 'Employee',
  operations: 'Operations',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  partner_ops: 'Partner Ops',
  agent_ops: 'Agent Ops',
  crm: 'CRM',
  hr: 'HR',
  fin_ops: 'Financial Ops',
  manager: 'Manager',
  coo: 'COO',
  cfo: 'CFO',
  cto: 'CTO',
  ceo: 'CEO',
  super_admin: 'Super Admin',
};

function formatRoleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'Never';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return formatDistanceToNow(date, { addSuffix: true });
}

export function ZoeConversationsPanel() {
  const { roles } = useAuth();
  const isAuthorizedReviewer = canReviewZoeConversations(roles);

  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [onlyThumbsDown, setOnlyThumbsDown] = useState<boolean>(false);
  const [onlyUnanswered, setOnlyUnanswered] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [selectedConversation, setSelectedConversation] =
    useState<ZoeCrmConversationRow | null>(null);
  const [editingUnansweredId, setEditingUnansweredId] = useState<string | null>(
    null,
  );
  const [reviewNoteDraft, setReviewNoteDraft] = useState<string>('');
  const [teachingDeptFilter, setTeachingDeptFilter] = useState<string>('all');
  const [teachingAnswerDrafts, setTeachingAnswerDrafts] = useState<
    Record<string, string>
  >({});
  const [teachingLeadNameDraft, setTeachingLeadNameDraft] = useState<string>(
    'Department Lead',
  );

  const dashboardQuery = useZoeCrmDashboard(
    {
      roleFilter,
      onlyThumbsDown,
      onlyUnanswered,
      limit: 150,
    },
    isAuthorizedReviewer,
  );

  const threadQuery = useZoeCrmThread(
    isAuthorizedReviewer && selectedConversation
      ? selectedConversation.id
      : null,
  );
  const errorSummaryQuery = useZoeErrorSummary(14, isAuthorizedReviewer);
  const weeklyLearningQuery = useZoeWeeklyLearningView(7, isAuthorizedReviewer);
  const realUseQuery = useZoeRealUseDashboard(14, isAuthorizedReviewer);
  const teachingQueueQuery = useZoeTeachingQueue(
    teachingDeptFilter,
    'open',
    isAuthorizedReviewer,
  );
  const updateUnanswered = useUpdateZoeUnanswered();
  const promoteEvalCandidate = usePromoteZoeEvalCandidate();
  const teachFromQueue = useTeachZoeFromQueue();

  const data = dashboardQuery.data;
  const weeklyLearning = weeklyLearningQuery.data ?? {
    ok: true,
    source: 'staff_assistant_weekly_manager_learning_view',
    days: 7,
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
    error: null,
  };
  const errorSummary = errorSummaryQuery.data ?? {
    ok: true,
    source: 'staff_assistant_error_summary',
    days: 14,
    from_date: '',
    to_date: '',
    total_errors: 0,
    by_code: [],
    by_day: [],
    error: null,
  };

  const filteredConversations = useMemo(() => {
    const raw = data?.conversations ?? [];
    return filterZoeConversations(raw, {
      roleFilter,
      onlyThumbsDown,
      onlyUnanswered,
      search: searchQuery,
    });
  }, [
    data?.conversations,
    roleFilter,
    onlyThumbsDown,
    onlyUnanswered,
    searchQuery,
  ]);

  const roleOptions = useMemo(() => {
    const dynamicRoles = data?.available_roles ?? [];
    const baseRoles = [
      'tenant_ops',
      'landlord_ops',
      'partner_ops',
      'agent_ops',
      'fin_ops',
      'crm',
      'hr',
      'operations',
      'employee',
      'manager',
      'coo',
      'cfo',
      'cto',
      'ceo',
      'super_admin',
    ];
    return Array.from(new Set([...dynamicRoles, ...baseRoles]));
  }, [data?.available_roles]);

  if (!isAuthorizedReviewer) {
    return (
      <Card
        data-testid="zoe-crm-access-denied"
        className="border-destructive/30 bg-destructive/5"
      >
        <CardContent className="p-6 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">
              CRM Reviewer Access Required
            </h2>
            <p className="text-xs text-muted-foreground">
              Only authorized CRM reviewers ({ZOE_CRM_REVIEWER_ROLES.join(', ')})
              can open the Zoe staff assistant review panel.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const config = data?.config ?? {
    enabled: true,
    max_questions_per_day: 50,
    max_emails_per_day: 30,
    history_days: 90,
  };

  const summary = data?.summary ?? {
    total_conversations: 0,
    conversations_with_thumbs_down: 0,
    conversations_with_unanswered: 0,
    open_unanswered_count: 0,
    active_staff_today: 0,
    questions_asked_today: 0,
    emails_sent_today: 0,
  };

  const weeklyUnanswered = data?.weekly_unanswered_summary ?? [];
  const weeklyThumbsDown = data?.weekly_thumbs_down_summary ?? [];
  const dailyUsageRows = data?.daily_usage_per_person ?? [];

  const handleSaveUnansweredReview = (
    item: ZoeWeeklyUnansweredRow,
    status: ZoeUnansweredStatus,
    note?: string,
  ) => {
    updateUnanswered.mutate(
      {
        id: item.latest_id,
        status,
        review_note: note ?? item.latest_review_note ?? undefined,
      },
      {
        onSuccess: () => {
          toast.success('Updated unanswered question status');
          setEditingUnansweredId(null);
          setReviewNoteDraft('');
        },
        onError: (err) => {
          toast.error(err instanceof Error ? err.message : 'Update failed');
        },
      },
    );
  };

  return (
    <div className="space-y-5" data-testid="zoe-conversations-panel">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            Zoe Staff Assistant Review
          </h2>
          <p className="text-xs text-muted-foreground">
            Review staff Zoe chats by role, thumbs-down feedback, unanswered
            questions, and daily usage against the configured budget.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Badge
            variant={config.enabled ? 'secondary' : 'destructive'}
            className="text-xs"
          >
            {config.enabled ? 'Zoe Enabled' : 'Zoe Paused'} ·{' '}
            {config.max_questions_per_day} questions/day ·{' '}
            {config.max_emails_per_day} emails/day
          </Badge>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => dashboardQuery.refetch()}
            disabled={dashboardQuery.isFetching}
            data-testid="zoe-crm-refresh-button"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${
                dashboardQuery.isFetching ? 'animate-spin' : ''
              }`}
            />
            Refresh
          </Button>
        </div>
      </div>

      {/* Model Drift Warning Banner (compares last 50 gateway replies against staff_assistant_config) */}
      {realUseQuery.data?.model_drift?.drift_detected && (
        <Card
          data-testid="zoe-model-drift-warning-banner"
          className="border-amber-400/70 bg-amber-50/80 dark:bg-amber-950/30"
        >
          <CardContent className="p-3.5 flex items-start gap-3 text-xs text-amber-950 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="space-y-1 flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">
                  AI Gateway Model Drift Detected
                </span>
                <Badge variant="outline" className="text-xs border-amber-500/50">
                  {realUseQuery.data.model_drift.mismatched_count} /{' '}
                  {realUseQuery.data.model_drift.checked_count} recent replies
                  mismatched
                </Badge>
              </div>
              <p>
                {realUseQuery.data.model_drift.warning_message ??
                  `Recent Zoe replies were answered by ${realUseQuery.data.model_drift.dominant_gateway_model ?? 'an unconfigured model'} instead of staff_assistant_config (${realUseQuery.data.model_drift.configured_model_fast} / ${realUseQuery.data.model_drift.configured_model_deep}).`}
              </p>
              <p className="text-amber-800/90 dark:text-amber-300/90">
                Configured fast: <code>{realUseQuery.data.model_drift.configured_model_fast}</code>{' '}
                · Configured deep: <code>{realUseQuery.data.model_drift.configured_model_deep}</code>{' '}
                · Observed gateway model:{' '}
                <code>{realUseQuery.data.model_drift.dominant_gateway_model ?? 'unknown'}</code>
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Summary KPI Strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Card>
          <CardContent className="p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Conversations</span>
              <MessageSquare className="h-3.5 w-3.5" />
            </div>
            <p
              className="text-xl font-bold mt-1"
              data-testid="zoe-kpi-total-conversations"
            >
              {summary.total_conversations}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Retention: {config.history_days} days
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Thumbs-down</span>
              <ThumbsDown className="h-3.5 w-3.5 text-destructive" />
            </div>
            <p
              className="text-xl font-bold mt-1 text-destructive"
              data-testid="zoe-kpi-thumbs-down"
            >
              {summary.conversations_with_thumbs_down}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Chats flagged by staff
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Zoe could not answer</span>
              <HelpCircle className="h-3.5 w-3.5 text-amber-600" />
            </div>
            <p
              className="text-xl font-bold mt-1"
              data-testid="zoe-kpi-unanswered"
            >
              {summary.conversations_with_unanswered}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {summary.open_unanswered_count} open in queue
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Questions Today</span>
              <Users className="h-3.5 w-3.5 text-primary" />
            </div>
            <p
              className="text-xl font-bold mt-1"
              data-testid="zoe-kpi-questions-today"
            >
              {summary.questions_asked_today}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {summary.active_staff_today} staff · limit{' '}
              {config.max_questions_per_day}/person
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-3.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Report Emails Today</span>
              <Mail className="h-3.5 w-3.5 text-primary" />
            </div>
            <p
              className="text-xl font-bold mt-1"
              data-testid="zoe-kpi-emails-today"
            >
              {summary.emails_sent_today}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Daily budget: {config.max_emails_per_day}/person
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Main Review Tabs */}
      <Tabs defaultValue="conversations" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger
            value="conversations"
            data-testid="zoe-tab-conversations"
          >
            Conversations ({filteredConversations.length})
          </TabsTrigger>
          <TabsTrigger
            value="weekly-unanswered"
            data-testid="zoe-tab-weekly-unanswered"
          >
            Weekly Unanswered Summary ({weeklyUnanswered.length})
          </TabsTrigger>
          <TabsTrigger value="daily-usage" data-testid="zoe-tab-daily-usage">
            Daily Usage vs Budget ({dailyUsageRows.length})
          </TabsTrigger>
          <TabsTrigger value="error-summary" data-testid="zoe-tab-error-summary">
            Error Summary ({errorSummary.total_errors})
          </TabsTrigger>
          <TabsTrigger value="learning-loop" data-testid="zoe-tab-learning-loop">
            Weekly Learning &amp; Review Queue ({weeklyLearning.review_queue.length})
          </TabsTrigger>
          <TabsTrigger
            value="real-use-dashboard"
            data-testid="zoe-tab-real-use-dashboard"
          >
            Real-Use Dashboard
          </TabsTrigger>
          <TabsTrigger
            value="teaching-queue"
            data-testid="zoe-tab-teaching-queue"
          >
            Teaching Queue ({(teachingQueueQuery.data ?? []).length})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: CONVERSATIONS + FILTERS */}
        <TabsContent value="conversations" className="space-y-3">
          {/* Filter Controls */}
          <Card>
            <CardContent className="p-3.5 flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="h-4 w-4 absolute left-2.5 top-2.5 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search staff name, email, role, or question..."
                  className="pl-8 h-9 text-xs"
                  data-testid="zoe-filter-search"
                />
              </div>

              <div className="w-[180px]">
                <Select
                  value={roleFilter}
                  onValueChange={(val) => setRoleFilter(val)}
                >
                  <SelectTrigger
                    className="h-9 text-xs"
                    data-testid="zoe-filter-role-select"
                  >
                    <Filter className="h-3.5 w-3.5 mr-1.5 text-muted-foreground" />
                    <SelectValue placeholder="Filter by role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All staff roles</SelectItem>
                    {roleOptions.map((r) => (
                      <SelectItem key={r} value={r}>
                        {formatRoleLabel(r)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                type="button"
                size="sm"
                variant={onlyThumbsDown ? 'default' : 'outline'}
                onClick={() => setOnlyThumbsDown((prev) => !prev)}
                className="h-9 text-xs gap-1.5"
                data-testid="zoe-filter-thumbs-down"
                aria-pressed={onlyThumbsDown}
              >
                <ThumbsDown className="h-3.5 w-3.5" />
                Thumbs-down only
              </Button>

              <Button
                type="button"
                size="sm"
                variant={onlyUnanswered ? 'default' : 'outline'}
                onClick={() => setOnlyUnanswered((prev) => !prev)}
                className="h-9 text-xs gap-1.5"
                data-testid="zoe-filter-unanswered"
                aria-pressed={onlyUnanswered}
              >
                <HelpCircle className="h-3.5 w-3.5" />
                Zoe could not answer
              </Button>

              {(roleFilter !== 'all' ||
                onlyThumbsDown ||
                onlyUnanswered ||
                searchQuery.trim() !== '') && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-9 text-xs"
                  data-testid="zoe-filter-clear"
                  onClick={() => {
                    setRoleFilter('all');
                    setOnlyThumbsDown(false);
                    setOnlyUnanswered(false);
                    setSearchQuery('');
                  }}
                >
                  Reset filters
                </Button>
              )}
            </CardContent>
          </Card>

          {/* Conversation List */}
          {dashboardQuery.isLoading ? (
            <Card>
              <CardContent className="p-8 text-center text-xs text-muted-foreground">
                Loading Zoe conversations...
              </CardContent>
            </Card>
          ) : dashboardQuery.isError ? (
            <Card className="border-destructive/30">
              <CardContent className="p-6 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>
                    Failed to load Zoe conversations:{' '}
                    {dashboardQuery.error instanceof Error
                      ? dashboardQuery.error.message
                      : 'Unknown error'}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => dashboardQuery.refetch()}
                >
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : filteredConversations.length === 0 ? (
            <Card data-testid="zoe-conversations-empty">
              <CardContent className="p-8 text-center text-xs text-muted-foreground">
                No Zoe conversations match the active filters.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2" data-testid="zoe-conversation-list">
              {filteredConversations.map((conv) => (
                <Card
                  key={conv.id}
                  data-testid={`zoe-conversation-card-${conv.id}`}
                  className="hover:border-primary/40 transition-colors cursor-pointer"
                  onClick={() => setSelectedConversation(conv)}
                >
                  <CardContent className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1.5 min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        <span className="font-semibold text-sm truncate">
                          {conv.staff_name}
                        </span>
                        {conv.staff_email && (
                          <span className="text-xs text-muted-foreground truncate">
                            ({conv.staff_email})
                          </span>
                        )}
                        {conv.staff_roles.map((r) => (
                          <Badge
                            key={r}
                            variant="outline"
                            className="text-xs py-0"
                          >
                            {formatRoleLabel(r)}
                          </Badge>
                        ))}
                        {(conv.has_thumbs_down || conv.thumbs_down_count > 0) && (
                          <Badge
                            variant="destructive"
                            className="text-xs gap-1"
                            data-testid={`zoe-badge-thumbs-down-${conv.id}`}
                          >
                            <ThumbsDown className="h-3 w-3" />
                            Thumbs-down ({conv.thumbs_down_count})
                          </Badge>
                        )}
                        {(conv.has_unanswered || conv.unanswered_count > 0) && (
                          <Badge
                            variant="secondary"
                            className="text-xs gap-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
                            data-testid={`zoe-badge-unanswered-${conv.id}`}
                          >
                            <HelpCircle className="h-3 w-3" />
                            Zoe could not answer ({conv.unanswered_count})
                          </Badge>
                        )}
                      </div>

                      {conv.last_user_question && (
                        <p className="text-xs text-foreground line-clamp-1">
                          <span className="font-medium text-muted-foreground">
                            Asked:{' '}
                          </span>
                          {conv.last_user_question}
                        </p>
                      )}

                      {(conv.last_outcome ||
                        (Array.isArray(conv.last_tools_called) &&
                          conv.last_tools_called.length > 0)) && (
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          {conv.last_outcome && (
                            <Badge
                              variant="outline"
                              className="text-xs py-0"
                              data-testid={`zoe-card-outcome-${conv.id}`}
                            >
                              Outcome: {conv.last_outcome}
                            </Badge>
                          )}
                          {Array.isArray(conv.last_tools_called) &&
                            conv.last_tools_called.map((toolName) => (
                              <Badge
                                key={`${conv.id}-tool-${toolName}`}
                                variant="secondary"
                                className="text-xs py-0 gap-1"
                              >
                                <Wrench className="h-3 w-3" />
                                {toolName}
                              </Badge>
                            ))}
                        </div>
                      )}
                    </div>

                    <div className="flex sm:flex-col items-end justify-between gap-1 shrink-0 text-right">
                      <Badge variant="secondary" className="text-xs">
                        {conv.message_count} msgs
                      </Badge>
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatRelativeTime(conv.last_message_at)}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        {/* TAB 2: WEEKLY SUMMARY OF MOST-ASKED UNANSWERED QUESTIONS */}
        <TabsContent value="weekly-unanswered" forceMount className="space-y-3 data-[state=inactive]:hidden">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Calendar className="h-4 w-4 text-primary" />
                Weekly Summary: Most-Asked Unanswered Questions (Last 7 Days)
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Questions staff asked over the past 7 days where Zoe could not
                answer (no matching report tool, role restriction, or budget/tool
                refusal), grouped by frequency.
              </p>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {weeklyUnanswered.length === 0 ? (
                <div
                  className="p-6 text-center text-xs text-muted-foreground"
                  data-testid="zoe-weekly-unanswered-empty"
                >
                  No unanswered questions recorded in the last 7 days.
                </div>
              ) : (
                weeklyUnanswered.map((item) => {
                  const isEditing = editingUnansweredId === item.latest_id;
                  return (
                    <Card
                      key={item.latest_id}
                      data-testid={`zoe-weekly-unanswered-item-${item.latest_id}`}
                      className="border-border/80"
                    >
                      <CardContent className="p-3.5 space-y-2">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="space-y-1 flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge variant="default" className="text-xs">
                                Asked {item.ask_count}x
                              </Badge>
                              <Badge variant="outline" className="text-xs">
                                {item.unique_staff_count} staff
                              </Badge>
                              <Badge variant="secondary" className="text-xs">
                                Reason: {item.latest_reason.replace(/_/g, ' ')}
                              </Badge>
                              {item.roles_asking.map((role) => (
                                <Badge
                                  key={role}
                                  variant="outline"
                                  className="text-xs"
                                >
                                  {formatRoleLabel(role)}
                                </Badge>
                              ))}
                            </div>
                            <p className="text-sm font-medium text-foreground">
                              {item.question_text}
                            </p>
                            {item.latest_review_note && (
                              <p className="text-xs text-muted-foreground">
                                <span className="font-medium">
                                  Reviewer note:{' '}
                                </span>
                                {item.latest_review_note}
                              </p>
                            )}
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <Select
                              value={item.latest_status}
                              onValueChange={(val) =>
                                handleSaveUnansweredReview(
                                  item,
                                  val as ZoeUnansweredStatus,
                                )
                              }
                            >
                              <SelectTrigger className="w-[125px] h-8 text-xs">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="open">Open</SelectItem>
                                <SelectItem value="reviewed">
                                  Reviewed
                                </SelectItem>
                                <SelectItem value="planned">Planned</SelectItem>
                                <SelectItem value="dismissed">
                                  Dismissed
                                </SelectItem>
                              </SelectContent>
                            </Select>

                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs"
                              onClick={() => {
                                if (isEditing) {
                                  setEditingUnansweredId(null);
                                  setReviewNoteDraft('');
                                } else {
                                  setEditingUnansweredId(item.latest_id);
                                  setReviewNoteDraft(
                                    item.latest_review_note ?? '',
                                  );
                                }
                              }}
                            >
                              {isEditing ? 'Cancel' : 'Add Note'}
                            </Button>
                          </div>
                        </div>

                        {isEditing && (
                          <div className="flex items-end gap-2 pt-1">
                            <Textarea
                              value={reviewNoteDraft}
                              onChange={(e) =>
                                setReviewNoteDraft(e.target.value)
                              }
                              placeholder="Add CRM review note or planned report tool..."
                              className="text-xs min-h-[60px]"
                            />
                            <Button
                              type="button"
                              size="sm"
                              onClick={() =>
                                handleSaveUnansweredReview(
                                  item,
                                  item.latest_status === 'open'
                                    ? 'reviewed'
                                    : item.latest_status,
                                  reviewNoteDraft,
                                )
                              }
                              disabled={updateUnanswered.isPending}
                            >
                              Save
                            </Button>
                          </div>
                        )}
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </CardContent>
          </Card>

          {/* Weekly Thumbs-Down Learning Loop (Redacted: never shows assistant answer or figures) */}
          <Card data-testid="zoe-weekly-thumbs-down-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <ThumbsDown className="h-4 w-4 text-destructive" />
                Weekly Learning Loop: Thumbs-Down Questions (Last 7 Days · Redacted)
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Staff questions that received thumbs-down feedback over the last 7 days, with caller roles, tool names, outcome, and staff comment. Assistant answer text and figures are redacted.
              </p>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {weeklyThumbsDown.length === 0 ? (
                <div
                  className="p-4 text-center text-xs text-muted-foreground"
                  data-testid="zoe-weekly-thumbs-down-empty"
                >
                  No thumbs-down feedback recorded in the last 7 days.
                </div>
              ) : (
                weeklyThumbsDown.map((downItem, idx) => (
                  <Card
                    key={`${downItem.latest_conversation_id}-${idx}`}
                    data-testid={`zoe-weekly-thumbs-down-item-${idx}`}
                    className="border-destructive/30"
                  >
                    <CardContent className="p-3.5 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="destructive" className="text-xs">
                          Thumbs-down {downItem.thumbs_down_count}x
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {downItem.unique_staff_count} staff
                        </Badge>
                        {downItem.latest_outcome && (
                          <Badge variant="secondary" className="text-xs">
                            Outcome: {downItem.latest_outcome}
                          </Badge>
                        )}
                        {downItem.roles_reporting?.map((role) => (
                          <Badge key={role} variant="outline" className="text-xs">
                            {formatRoleLabel(role)}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-sm font-medium text-foreground">
                        {downItem.question_text}
                      </p>
                      {downItem.latest_comment && (
                        <p className="text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">Staff comment: </span>
                          {downItem.latest_comment}
                        </p>
                      )}
                      {Array.isArray(downItem.tools_called) && downItem.tools_called.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                          {downItem.tools_called.map((toolName) => (
                            <Badge key={toolName} variant="secondary" className="text-xs gap-1">
                              <Wrench className="h-3 w-3" />
                              {toolName}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 3: DAILY USAGE PER PERSON AGAINST STAFF_ASSISTANT_CONFIG BUDGET */}
        <TabsContent value="daily-usage" className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Users className="h-4 w-4 text-primary" />
                    Daily Usage per Person vs staff_assistant_config Budget
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Kampala day ({data?.kampala_date || 'today'}) question and
                    report-email usage per staff member against{' '}
                    <code className="font-mono">staff_assistant_config</code> (
                    {config.max_questions_per_day} questions/day,{' '}
                    {config.max_emails_per_day} emails/day).
                  </p>
                </div>
                <Badge variant="outline" className="text-xs">
                  Daily Question Budget: {config.max_questions_per_day} / person
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-2.5">
              {dailyUsageRows.length === 0 ? (
                <div
                  className="p-6 text-center text-xs text-muted-foreground"
                  data-testid="zoe-daily-usage-empty"
                >
                  No staff usage recorded yet.
                </div>
              ) : (
                <div className="space-y-2" data-testid="zoe-daily-usage-list">
                  {dailyUsageRows.map((row) => {
                    const pct = computeBudgetUtilizationPct(
                      row.questions_today,
                      row.max_questions_per_day,
                    );
                    const isNearOrAtLimit = pct >= 80;
                    return (
                      <Card
                        key={row.user_id}
                        data-testid={`zoe-usage-row-${row.user_id}`}
                        className="border-border/80"
                      >
                        <CardContent className="p-3.5 space-y-2">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-semibold">
                                {row.staff_name}
                              </span>
                              {row.staff_email && (
                                <span className="text-xs text-muted-foreground">
                                  ({row.staff_email})
                                </span>
                              )}
                              {row.staff_roles.map((r) => (
                                <Badge
                                  key={r}
                                  variant="outline"
                                  className="text-xs py-0"
                                >
                                  {formatRoleLabel(r)}
                                </Badge>
                              ))}
                            </div>

                            <div className="flex items-center gap-2 flex-wrap text-xs">
                              <Badge
                                variant={
                                  isNearOrAtLimit ? 'destructive' : 'secondary'
                                }
                                data-testid={`zoe-usage-questions-${row.user_id}`}
                              >
                                Questions: {row.questions_today} /{' '}
                                {row.max_questions_per_day} (
                                {row.questions_remaining} left)
                              </Badge>
                              <Badge
                                variant="outline"
                                data-testid={`zoe-usage-emails-${row.user_id}`}
                              >
                                Emails: {row.emails_today} /{' '}
                                {row.max_emails_per_day}
                              </Badge>
                            </div>
                          </div>

                          {/* Budget Progress Bar */}
                          <div className="space-y-1">
                            <div className="w-full h-2 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full transition-all ${
                                  isNearOrAtLimit
                                    ? 'bg-destructive'
                                    : 'bg-primary'
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>Budget utilization: {pct}%</span>
                              <span>
                                Last active:{' '}
                                {formatRelativeTime(row.last_active_at)}
                              </span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 4: ADMIN ERROR SUMMARY BY ERROR_CODE AND DAY (NO USER TEXT) */}
        <TabsContent
          value="error-summary"
          forceMount
          className="space-y-3 data-[state=inactive]:hidden"
        >
          <Card data-testid="zoe-error-summary-card">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-destructive" />
                    Technical Error Summary (Last {errorSummary.days} Days · No User Text)
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Counts of degraded dependencies and database parity errors by{' '}
                    <code className="font-mono">error_code</code> and Kampala day from{' '}
                    <code className="font-mono">staff_assistant_error_summary</code>. Zero
                    user text or financial figures are included.
                  </p>
                </div>
                <Badge
                  variant={errorSummary.total_errors > 0 ? 'destructive' : 'secondary'}
                  className="text-xs"
                  data-testid="zoe-error-summary-total"
                >
                  Total logged errors: {errorSummary.total_errors}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {errorSummary.by_code.length === 0 ? (
                <div
                  className="p-6 text-center text-xs text-muted-foreground"
                  data-testid="zoe-error-summary-empty"
                >
                  No technical error codes logged in the last {errorSummary.days} days.
                </div>
              ) : (
                <>
                  <div className="space-y-2" data-testid="zoe-error-summary-by-code">
                    <h3 className="text-xs font-semibold text-foreground">
                      Counts by Error Code
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {errorSummary.by_code.map((item) => (
                        <div
                          key={item.error_code}
                          data-testid={`zoe-error-code-row-${item.error_code}`}
                          className="rounded-lg border border-border p-3 flex items-center justify-between gap-2"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <p className="text-xs font-mono font-semibold text-foreground truncate">
                              {item.error_code}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {item.unique_staff_count} staff · Last seen{' '}
                              {formatRelativeTime(item.last_seen_at)}
                            </p>
                          </div>
                          <Badge variant="destructive" className="text-xs shrink-0">
                            {item.total_count}x
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>

                  {errorSummary.by_day.length > 0 && (
                    <div className="space-y-2" data-testid="zoe-error-summary-by-day">
                      <h3 className="text-xs font-semibold text-foreground">
                        Daily Breakdown (Kampala Day)
                      </h3>
                      <div className="space-y-1.5">
                        {errorSummary.by_day.map((dayRow, idx) => (
                          <div
                            key={`${dayRow.day_kampala}-${dayRow.error_code}-${idx}`}
                            data-testid={`zoe-error-day-row-${dayRow.day_kampala}-${dayRow.error_code}`}
                            className="rounded border border-border/70 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                          >
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-xs font-mono">
                                {dayRow.day_kampala}
                              </Badge>
                              <span className="font-mono font-medium text-foreground">
                                {dayRow.error_code}
                              </span>
                            </div>
                            <div className="flex items-center gap-2 text-muted-foreground">
                              <span>{dayRow.unique_staff_count} staff</span>
                              <Badge variant="secondary" className="text-xs">
                                {dayRow.error_count}
                              </Badge>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 5: PROMPT 4 WEEKLY LEARNING VIEW & REDACTED REVIEW QUEUE ("ADD TO TESTS") */}
        <TabsContent
          value="learning-loop"
          forceMount
          className="space-y-3 data-[state=inactive]:hidden"
        >
          <Card data-testid="zoe-weekly-learning-card">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Bot className="h-4 w-4 text-primary" />
                    Weekly Manager Learning View (Last {weeklyLearning.days} Days · No Individual Staff Text)
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">
                    Top topics, unanswered themes, thumbs-down themes, and cost from{' '}
                    <code className="font-mono">staff_assistant_learning_log</code>, plus the redacted review queue with one-tap promotion to{' '}
                    <code className="font-mono">staff_assistant_eval_candidates</code>.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <Badge variant="outline" data-testid="zoe-learning-total-cost">
                    Cost: ${Number(weeklyLearning.cost_summary.total_cost_usd ?? 0).toFixed(4)}
                  </Badge>
                  <Badge variant="secondary" data-testid="zoe-learning-avg-latency">
                    Avg latency: {Math.round(Number(weeklyLearning.cost_summary.avg_latency_ms ?? 0))} ms
                  </Badge>
                  <Badge variant="outline" data-testid="zoe-learning-thumbs-down-rate">
                    Thumbs-down: {Number(weeklyLearning.cost_summary.thumbs_down_rate_pct ?? 0).toFixed(1)}%
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Top Topics (No individual staff text) */}
              <div className="space-y-2" data-testid="zoe-learning-top-topics">
                <h3 className="text-xs font-semibold text-foreground">
                  Top Topics (Fixed Topic List · No Individual Staff Text)
                </h3>
                {weeklyLearning.top_topics.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No learning log topics recorded in the last {weeklyLearning.days} days.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {weeklyLearning.top_topics.map((topicRow) => (
                      <div
                        key={topicRow.topic}
                        data-testid={`zoe-learning-topic-${topicRow.topic}`}
                        className="rounded-lg border border-border p-3 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="space-y-0.5">
                          <p className="font-semibold text-foreground">
                            {topicRow.topic.replace(/_/g, ' ')}
                          </p>
                          <p className="text-muted-foreground">
                            Answered {topicRow.answered_count} · Unanswered {topicRow.unanswered_count} · Avg {topicRow.avg_latency_ms} ms
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary" className="text-xs">
                            {topicRow.ask_count} asks
                          </Badge>
                          {topicRow.thumbs_down_count > 0 && (
                            <Badge variant="destructive" className="text-xs">
                              {topicRow.thumbs_down_count} down
                            </Badge>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Thumbs-down & Unanswered Themes */}
              {(weeklyLearning.thumbs_down_themes.length > 0 ||
                weeklyLearning.unanswered_themes.length > 0) && (
                <div
                  className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                  data-testid="zoe-learning-themes"
                >
                  <div className="rounded-lg border border-border p-3 space-y-1.5">
                    <h4 className="text-xs font-semibold text-foreground">
                      Thumbs-Down Themes
                    </h4>
                    {weeklyLearning.thumbs_down_themes.length === 0 ? (
                      <p className="text-xs text-muted-foreground">None recorded.</p>
                    ) : (
                      weeklyLearning.thumbs_down_themes.map((th, idx) => (
                        <div
                          key={`${th.topic}-${th.feedback_theme}-${idx}`}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-foreground">
                            {th.topic.replace(/_/g, ' ')} · {th.feedback_theme.replace(/_/g, ' ')} ({th.tool_used})
                          </span>
                          <Badge variant="destructive" className="text-xs">
                            {th.count}x
                          </Badge>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="rounded-lg border border-border p-3 space-y-1.5">
                    <h4 className="text-xs font-semibold text-foreground">
                      Questions Zoe Could Not Answer (By Topic)
                    </h4>
                    {weeklyLearning.unanswered_themes.length === 0 ? (
                      <p className="text-xs text-muted-foreground">None recorded.</p>
                    ) : (
                      weeklyLearning.unanswered_themes.map((ut, idx) => (
                        <div
                          key={`${ut.topic}-${ut.outcome}-${idx}`}
                          className="flex items-center justify-between text-xs"
                        >
                          <span className="text-foreground">
                            {ut.topic.replace(/_/g, ' ')} ({ut.outcome})
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {ut.count}x
                          </Badge>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Redacted Review Queue with "Add to tests" */}
              <div className="space-y-2" data-testid="zoe-learning-review-queue">
                <h3 className="text-xs font-semibold text-foreground">
                  Redacted Review Queue (Thumbs-Down &amp; Problem Reports)
                </h3>
                {weeklyLearning.review_queue.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No open items in the review queue.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {weeklyLearning.review_queue.map((item: ZoeLearningReviewQueueItem) => (
                      <div
                        key={`${item.source_kind}-${item.source_id}`}
                        data-testid={`zoe-review-queue-item-${item.source_id}`}
                        className="rounded-lg border border-border p-3 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant="outline" className="text-xs">
                              {item.source_kind}
                            </Badge>
                            <Badge variant="secondary" className="text-xs">
                              Tool: {item.tool_used}
                            </Badge>
                            <Badge variant="outline" className="text-xs">
                              Outcome: {item.outcome}
                            </Badge>
                          </div>
                          <p className="font-medium text-foreground break-words">
                            {item.question_redacted}
                          </p>
                          {item.comment_redacted && (
                            <p className="text-muted-foreground break-words">
                              Comment (redacted): {item.comment_redacted}
                            </p>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={promoteEvalCandidate.isPending}
                          data-testid={`zoe-add-to-tests-${item.source_id}`}
                          onClick={() => {
                            promoteEvalCandidate.mutate(
                              {
                                source_kind: item.source_kind,
                                source_id: item.source_id,
                                cleaned_question: item.question_redacted,
                                expected_tool:
                                  item.tool_used && item.tool_used !== 'none'
                                    ? item.tool_used
                                    : null,
                              },
                              {
                                onSuccess: () => {
                                  toast.success('Added cleaned question to evaluation set');
                                },
                                onError: (err) => {
                                  toast.error(
                                    err instanceof Error
                                      ? err.message
                                      : 'Could not add to evaluation set',
                                  );
                                },
                              },
                            );
                          }}
                          className="text-xs"
                        >
                          Add to tests
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Promoted Evaluation Set Candidates */}
              {weeklyLearning.eval_candidates.length > 0 && (
                <div className="space-y-2" data-testid="zoe-eval-candidates-list">
                  <h3 className="text-xs font-semibold text-foreground">
                    Promoted Evaluation Candidates ({weeklyLearning.eval_candidates.length})
                  </h3>
                  <div className="space-y-1.5">
                    {weeklyLearning.eval_candidates.map((cand) => (
                      <div
                        key={cand.id}
                        data-testid={`zoe-eval-candidate-${cand.id}`}
                        className="rounded border border-border/70 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs"
                      >
                        <span className="font-medium text-foreground break-words">
                          {cand.cleaned_question}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {cand.expected_tool && (
                            <Badge variant="secondary" className="text-xs">
                              {cand.expected_tool}
                            </Badge>
                          )}
                          <Badge variant="outline" className="text-xs">
                            {cand.review_status}
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 6: REAL-USE DASHBOARD & ROLE GOALS (NON-CAUSAL) */}
        <TabsContent value="real-use-dashboard" className="space-y-4">
          <Card data-testid="zoe-real-use-dashboard-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold">
                Real-Use Dashboard (Last 14 Days · Official Learning &amp; Message Logs)
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-xs">
              {/* Plain Weekly Adoption Count & 8-Week Trend Line (Prompt 3 Deliverable 2) */}
              <div
                data-testid="zoe-weekly-adoption-card"
                className="rounded-xl border border-primary/25 bg-primary/5 p-3.5 space-y-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">
                      Weekly Staff Adoption (Last 7 Days)
                    </p>
                    <p
                      data-testid="zoe-weekly-adoption-count"
                      className="mt-1 text-xl font-bold text-foreground"
                    >
                      {realUseQuery.data?.weekly_active_staff ?? 0}{' '}
                      <span className="text-xs font-normal text-muted-foreground">
                        distinct staff used Zoe at least once in the last 7 days
                      </span>
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs">
                    Pre-work baseline:{' '}
                    {realUseQuery.data?.baseline_weekly_active_staff ?? 1} staff / week
                  </Badge>
                </div>

                {/* Simple 8-Week Trend Line */}
                <div data-testid="zoe-weekly-adoption-trend" className="space-y-1.5">
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>8-week weekly active staff trend</span>
                    <span>
                      {(realUseQuery.data?.weekly_active_staff ?? 0) >
                      (realUseQuery.data?.baseline_weekly_active_staff ?? 1)
                        ? 'Rising above pre-work baseline (1)'
                        : 'Target: more than 1 distinct staff per week, and rising'}
                    </span>
                  </div>
                  {(() => {
                    const trend = realUseQuery.data?.weekly_adoption_trend ?? [];
                    if (trend.length === 0) {
                      return (
                        <p className="text-[11px] text-muted-foreground">
                          Weekly trend points will appear as daily logs accumulate.
                        </p>
                      );
                    }
                    const maxStaff = Math.max(
                      2,
                      ...trend.map((pt) => pt.distinct_staff_count),
                    );
                    const svgWidth = 420;
                    const svgHeight = 52;
                    const padX = 12;
                    const padY = 8;
                    const usableW = svgWidth - padX * 2;
                    const usableH = svgHeight - padY * 2;
                    const points = trend
                      .map((pt, idx) => {
                        const x =
                          trend.length === 1
                            ? svgWidth / 2
                            : padX + (idx / (trend.length - 1)) * usableW;
                        const y =
                          padY +
                          usableH -
                          (pt.distinct_staff_count / maxStaff) * usableH;
                        return `${Math.round(x)},${Math.round(y)}`;
                      })
                      .join(' ');
                    return (
                      <div className="space-y-2">
                        <svg
                          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
                          className="h-14 w-full overflow-visible rounded-lg border border-border/60 bg-background/80 px-2 py-1"
                          role="img"
                          aria-label="Weekly distinct staff using Zoe over the last 8 weeks"
                          data-testid="zoe-weekly-adoption-trend-svg"
                        >
                          <polyline
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-primary"
                            points={points}
                          />
                          {trend.map((pt, idx) => {
                            const x =
                              trend.length === 1
                                ? svgWidth / 2
                                : padX + (idx / (trend.length - 1)) * usableW;
                            const y =
                              padY +
                              usableH -
                              (pt.distinct_staff_count / maxStaff) * usableH;
                            return (
                              <circle
                                key={pt.week_start || idx}
                                cx={Math.round(x)}
                                cy={Math.round(y)}
                                r="3.5"
                                className="fill-primary"
                              >
                                <title>
                                  {pt.week_label}: {pt.distinct_staff_count} staff (
                                  {pt.questions_count} questions)
                                </title>
                              </circle>
                            );
                          })}
                        </svg>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                          {trend.slice(-4).map((pt) => (
                            <div
                              key={pt.week_start}
                              className="rounded border border-border/70 bg-background px-2 py-1.5 flex items-center justify-between"
                            >
                              <span className="truncate text-[11px] text-muted-foreground">
                                {pt.week_label}
                              </span>
                              <span className="ml-1.5 font-semibold text-foreground">
                                {pt.distinct_staff_count} staff
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-lg border border-border p-3">
                  <p className="text-muted-foreground">Daily / Weekly Active Staff</p>
                  <p className="text-base font-bold text-foreground mt-1">
                    {realUseQuery.data?.daily_active_staff ?? 0} today ·{' '}
                    {realUseQuery.data?.weekly_active_staff ?? 0} (7d)
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-muted-foreground">Answer / Error Rate</p>
                  <p className="text-base font-bold text-foreground mt-1">
                    {realUseQuery.data?.answer_rate_pct ?? 0}% answered ·{' '}
                    {realUseQuery.data?.error_rate_pct ?? 0}% error
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-muted-foreground">Thumbs-up Rate</p>
                  <p className="text-base font-bold text-foreground mt-1">
                    {realUseQuery.data?.thumbs_up_rate_pct ?? 0}%
                  </p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-muted-foreground">TTFB / Total Time (p50 / p95)</p>
                  <p className="text-xs font-semibold text-foreground mt-1">
                    TTFB: {realUseQuery.data?.median_ttfb_ms ?? 0} /{' '}
                    {realUseQuery.data?.p95_ttfb_ms ?? 0} ms
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Total: {realUseQuery.data?.median_total_ms ?? 0} /{' '}
                    {realUseQuery.data?.p95_total_ms ?? 0} ms
                  </p>
                </div>
              </div>

              {/* Questions per role */}
              <div className="space-y-2">
                <h4 className="font-semibold text-foreground">Questions by Role</h4>
                {(realUseQuery.data?.questions_per_role ?? []).length === 0 ? (
                  <p className="text-muted-foreground">No role activity recorded yet.</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {(realUseQuery.data?.questions_per_role ?? []).map((row) => (
                      <div
                        key={row.role_bucket}
                        className="rounded-lg border border-border px-3 py-2 flex items-center justify-between"
                      >
                        <div>
                          <p className="font-medium text-foreground">
                            {formatRoleLabel(row.role_bucket)}
                          </p>
                          <p className="text-muted-foreground">
                            {row.answered_count} answered · {row.error_count} errors ·{' '}
                            {row.thumbs_up_count} up / {row.thumbs_down_count} down
                          </p>
                        </div>
                        <Badge variant="secondary">{row.questions_count} asks</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Role Goals & Measures (Descriptive trend only — never causal) */}
              {realUseQuery.data?.role_goals && (
                <div
                  data-testid="zoe-role-goals-section"
                  className="space-y-2 rounded-lg border border-border bg-muted/20 p-3"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h4 className="font-semibold text-foreground">
                      Role Goals &amp; Measures Alongside Zoe Adoption
                    </h4>
                    <Badge variant="outline" className="text-xs">
                      Descriptive Trend Only · Non-Causal
                    </Badge>
                  </div>
                  <p className="text-muted-foreground">
                    {realUseQuery.data.role_goals.disclaimer}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                    {realUseQuery.data.role_goals.role_goals.map((g) => (
                      <div
                        key={g.role}
                        className="rounded border border-border bg-background p-2.5 space-y-1"
                      >
                        <p className="font-semibold text-foreground">
                          {formatRoleLabel(g.role)} — {g.goal_label}
                        </p>
                        <p className="text-muted-foreground">
                          Official source: {g.official_source}
                        </p>
                        <p className="text-muted-foreground">{g.zoe_adoption_note}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* TAB 7: DEPARTMENT TEACHING QUEUE */}
        <TabsContent value="teaching-queue" className="space-y-4">
          <Card data-testid="zoe-teaching-queue-card">
            <CardHeader className="pb-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="text-sm font-semibold">
                  Department Teaching Queue (Named Lead Approval · 90-Day Review Expiry)
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Input
                    value={teachingLeadNameDraft}
                    onChange={(e) => setTeachingLeadNameDraft(e.target.value)}
                    placeholder="Approving Lead Name"
                    className="h-8 w-44 text-xs"
                    data-testid="zoe-teaching-lead-name-input"
                  />
                  <Select
                    value={teachingDeptFilter}
                    onValueChange={setTeachingDeptFilter}
                  >
                    <SelectTrigger
                      className="h-8 w-40 text-xs"
                      data-testid="zoe-teaching-dept-select"
                    >
                      <SelectValue placeholder="All departments" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All departments</SelectItem>
                      <SelectItem value="Landlord Ops">Landlord Ops</SelectItem>
                      <SelectItem value="Tenant Ops">Tenant Ops</SelectItem>
                      <SelectItem value="Agent Ops">Agent Ops</SelectItem>
                      <SelectItem value="Partner Ops">Partner Ops</SelectItem>
                      <SelectItem value="Financial Ops">Financial Ops</SelectItem>
                      <SelectItem value="HR & People">HR &amp; People</SelectItem>
                      <SelectItem value="CRM & Support">CRM &amp; Support</SelectItem>
                      <SelectItem value="General Operations">General Operations</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-xs">
              {(teachingQueueQuery.data ?? []).length === 0 ? (
                <p className="text-muted-foreground">
                  No open questions waiting in the department teaching queue.
                </p>
              ) : (
                (teachingQueueQuery.data ?? []).map(
                  (item: ZoeDepartmentTeachingQueueItem) => (
                    <div
                      key={item.id}
                      data-testid={`zoe-teaching-item-${item.id}`}
                      className="rounded-lg border border-border p-3 space-y-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary">{item.department}</Badge>
                          <Badge variant="outline">{item.source_kind}</Badge>
                        </div>
                        <span className="text-muted-foreground">
                          {formatRelativeTime(item.created_at)}
                        </span>
                      </div>
                      <p className="font-semibold text-foreground break-words">
                        {item.question_text}
                      </p>
                      {item.reason_or_comment && (
                        <p className="text-muted-foreground">
                          Reason / feedback: {item.reason_or_comment}
                        </p>
                      )}
                      <div className="flex flex-col sm:flex-row gap-2 pt-1">
                        <Textarea
                          rows={2}
                          value={teachingAnswerDrafts[item.id] ?? ''}
                          onChange={(e) =>
                            setTeachingAnswerDrafts((prev) => ({
                              ...prev,
                              [item.id]: e.target.value,
                            }))
                          }
                          placeholder="Write the official department-approved answer (cites process/source, expires for review in 90 days)..."
                          className="text-xs flex-1"
                          data-testid={`zoe-teaching-answer-input-${item.id}`}
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={
                            teachFromQueue.isPending ||
                            !(teachingAnswerDrafts[item.id] ?? '').trim()
                          }
                          data-testid={`zoe-teaching-approve-btn-${item.id}`}
                          onClick={() => {
                            teachFromQueue.mutate(
                              {
                                queue_id: item.id,
                                approved_answer: (
                                  teachingAnswerDrafts[item.id] ?? ''
                                ).trim(),
                                approved_by_name:
                                  teachingLeadNameDraft.trim() ||
                                  'Department Lead',
                                department: item.department,
                              },
                              {
                                onSuccess: () => {
                                  toast.success(
                                    `Approved and published to Zoe Knowledge (${item.department})`,
                                  );
                                },
                                onError: (err) => {
                                  toast.error(
                                    err instanceof Error
                                      ? err.message
                                      : 'Could not approve answer',
                                  );
                                },
                              },
                            );
                          }}
                        >
                          Approve &amp; Teach Zoe
                        </Button>
                      </div>
                    </div>
                  ),
                )
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Conversation Detail Sheet */}
      <Sheet
        open={Boolean(selectedConversation)}
        onOpenChange={(open) => {
          if (!open) setSelectedConversation(null);
        }}
      >
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 text-base">
              <Bot className="h-4 w-4 text-primary" />
              {selectedConversation?.staff_name ?? 'Zoe Conversation'}
            </SheetTitle>
            {selectedConversation && (
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                {selectedConversation.staff_email && (
                  <span>{selectedConversation.staff_email}</span>
                )}
                {selectedConversation.staff_roles.map((r) => (
                  <Badge key={r} variant="outline" className="text-xs py-0">
                    {formatRoleLabel(r)}
                  </Badge>
                ))}
              </div>
            )}
          </SheetHeader>

          <div
            className="mt-4 space-y-3"
            data-testid="zoe-conversation-thread"
          >
            {threadQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">
                Loading message thread...
              </p>
            ) : (threadQuery.data ?? []).length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No messages in this conversation.
              </p>
            ) : (
              (threadQuery.data ?? []).map((msg) => {
                const toolNames =
                  Array.isArray(msg.tools_called) && msg.tools_called.length > 0
                    ? msg.tools_called
                    : Array.isArray(msg.tool_calls)
                      ? msg.tool_calls
                          .map((tc) => tc.name)
                          .filter((n): n is string => Boolean(n))
                      : [];
                const outcomeLabel =
                  msg.outcome ??
                  (msg.unanswered_reason
                    ? 'unanswered'
                    : msg.error_code
                      ? 'error'
                      : 'answered');

                return (
                  <div
                    key={msg.id}
                    data-testid={`zoe-thread-message-${msg.id}`}
                    className={`rounded-lg p-3 text-xs space-y-1.5 ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground ml-6'
                        : 'bg-muted mr-4'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 opacity-75">
                      <span className="font-semibold uppercase">
                        {msg.role === 'user' ? 'Staff' : 'Zoe (Metadata Only)'}
                      </span>
                      <span>{new Date(msg.created_at).toLocaleString()}</span>
                    </div>

                    {msg.role === 'user' ? (
                      <p className="whitespace-pre-wrap leading-relaxed">
                        {msg.content}
                      </p>
                    ) : (
                      <div
                        data-testid={`zoe-thread-redacted-${msg.id}`}
                        className="rounded border border-border/60 bg-background/70 px-2.5 py-2 space-y-1.5 text-foreground"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant="outline"
                            className="text-xs"
                            data-testid={`zoe-thread-outcome-${msg.id}`}
                          >
                            Outcome: {outcomeLabel}
                          </Badge>
                          <span className="text-xs text-muted-foreground">
                            Answer text &amp; report figures redacted for role privacy
                          </span>
                        </div>

                        {toolNames.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {toolNames.map((name, i) => (
                              <Badge
                                key={`${msg.id}-tc-${i}`}
                                variant="outline"
                                className="text-xs gap-1"
                              >
                                <Wrench className="h-3 w-3" />
                                {name}
                              </Badge>
                            ))}
                          </div>
                        )}

                        {(msg.source_label ||
                          msg.period_label ||
                          (Array.isArray(msg.sources) &&
                            msg.sources.length > 0)) && (
                          <div className="text-xs text-muted-foreground pt-0.5">
                            {msg.source_label ? (
                              <div>
                                Source: {msg.source_label}
                                {msg.period_label
                                  ? ` · ${msg.period_label}`
                                  : ''}
                              </div>
                            ) : (
                              msg.sources.map((src, idx) => (
                                <div key={`${msg.id}-src-${idx}`}>
                                  Source:{' '}
                                  {src.source ?? src.tool ?? 'Official Report'}
                                  {src.period ? ` · ${src.period}` : ''}
                                </div>
                              ))
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Feedback & Unanswered Badges on Assistant Reply */}
                    {msg.role === 'assistant' &&
                      (msg.feedback_rating !== null ||
                        msg.unanswered_reason !== null) && (
                        <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-border/50">
                          {msg.feedback_rating === 1 && (
                            <Badge
                              variant="secondary"
                              className="text-xs gap-1 text-emerald-700"
                            >
                              <ThumbsUp className="h-3 w-3" />
                              Helpful
                              {msg.feedback_comment
                                ? `: ${msg.feedback_comment}`
                                : ''}
                            </Badge>
                          )}
                          {msg.feedback_rating === -1 && (
                            <Badge
                              variant="destructive"
                              className="text-xs gap-1"
                            >
                              <ThumbsDown className="h-3 w-3" />
                              Thumbs-down
                              {msg.feedback_comment
                                ? `: ${msg.feedback_comment}`
                                : ''}
                            </Badge>
                          )}
                          {msg.unanswered_reason && (
                            <Badge
                              variant="outline"
                              className="text-xs gap-1 border-amber-500/40 text-amber-700"
                            >
                              <CheckCircle2 className="h-3 w-3" />
                              Zoe could not answer (
                              {msg.unanswered_reason.replace(/_/g, ' ')})
                            </Badge>
                          )}
                        </div>
                      )}
                  </div>
                );
              })
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export default ZoeConversationsPanel;
