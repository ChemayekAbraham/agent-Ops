import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ArrowRight,
  BookOpen,
  Bookmark,
  Check,
  Copy,
  Database,
  Edit3,
  ExternalLink,
  History,
  Loader2,
  MessageSquarePlus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  evaluateZoeFileRequest,
  extractZoeActionDraft,
  extractZoeEmailDraft,
  extractZoeRemindersAndSchedules,
  type ConfirmZoeActionResult,
  type ConfirmZoeIdeaInput,
  type ConfirmZoeNotificationInput,
  type ConfirmZoeReminderInput,
  type ConfirmZoeScheduleInput,
  type SendZoeReportEmailInput,
  type SendZoeReportEmailResponse,
  type ZoeMorningBriefPayload,
} from '@/lib/zoe';
import {
  formatPlainZoeErrorMessage,
  getStarterSuggestionsForRoles,
  resolveSourceScreenLink,
  type ZoeSuggestion,
} from './zoeConfig';
import { ZoeActionDraftCard } from './ZoeActionDraftCard';
import { ZoeEmailDraftCard } from './ZoeEmailDraftCard';
import { ZoeMarkdown } from './ZoeMarkdown';
import { extractZoeChartFromMessage, ZoeMiniChart } from './ZoeMiniChart';
import { ZoeMorningBriefCard } from './ZoeMorningBriefCard';
import { ZoeReportCard } from './ZoeReportCard';
import { ZoeSchedulesAndRemindersCard } from './ZoeSchedulesAndRemindersCard';
import type {
  ZoeConversationListItem,
  ZoeFeedbackRating,
  ZoeGlossaryEntry,
  ZoeGlossaryUpsertInput,
  ZoeMessage,
  ZoeNoteItem,
} from './useZoeAssistant';

const MAX_MESSAGE_LENGTH = 2000;
const MAX_ZOE_NOTES = 20;

const GLOSSARY_MANAGER_ROLES = new Set([
  'manager',
  'coo',
  'cfo',
  'ceo',
  'cto',
  'super_admin',
]);

export const DEFAULT_WELILE_GLOSSARY_ENTRIES: ZoeGlossaryEntry[] = [
  {
    slug: 'expected_vs_collected',
    term: 'Expected vs Collected Repayments',
    category: 'measurement_gotcha',
    plain_definition:
      'Expected is the contractual daily or period repayment due on active Rent Plans; Collected is verified cash/wallet inflows posted to the general ledger.',
    measurement_gotcha:
      'Never subtract Collected from Total Disbursed to compute arrears; compare Collected against Expected Due to date on active plans.',
    official_source: 'assistant_staff_tenant_ops_overview · assistant_staff_cfo_collections_summary',
    screen_path: '',
  },
  {
    slug: 'treasury_cash_vs_wallet_liability',
    term: 'Treasury Cash vs Wallet Liability',
    category: 'measurement_gotcha',
    plain_definition:
      'Treasury cash is physical/bank/mobile-money cash held by Welile (A1–A3), whereas wallet balances are liabilities owed to users or earmarked operational float.',
    measurement_gotcha:
      'A high wallet balance total is not free company cash; check Cash Position and CFO Overview for net available liquidity.',
    official_source: 'assistant_staff_cfo_cash_and_wallets · Cash Position',
    screen_path: '',
  },
  {
    slug: 'active_rent_plan_clock',
    term: 'Active Rent Plan & Repayment Clock',
    category: 'measurement_gotcha',
    plain_definition:
      'A Rent Plan is in live repayment when status is funded or disbursed. Pre-disbursement stages (pending, tenant_ops_approved, landlord_ops_approved, coo_approved) are pipeline.',
    measurement_gotcha:
      'The daily repayment clock starts the day after landlord payout disbursement, not on the application date.',
    official_source: 'assistant_staff_rent_pipeline_summary · assistant_staff_tenant_ops_overview',
    screen_path: '',
  },
  {
    slug: 'agent_vs_sub_agent',
    term: 'Field Agent vs Sub-Agent',
    category: 'operations',
    plain_definition:
      'Field agents onboard tenants and landlords directly; sub-agents are recruited under a parent agent and share a split on registration/commission pools.',
    measurement_gotcha:
      'Agent lending uses agents own capital and is excluded from company Receivables.',
    official_source: 'assistant_staff_agent_ops_overview · assistant_staff_agent_commission_detail',
    screen_path: '',
  },
  {
    slug: 'regulatory_terminology',
    term: 'Mandatory Regulatory Terminology',
    category: 'definition',
    plain_definition:
      'Welile facilitates Rent Plans backed by Supporters who earn Returns.',
    measurement_gotcha:
      'Never use banned lending terms in staff or external copy; always use Rent Plan, Supporter, and Returns.',
    official_source: 'Welile Compliance Policy',
    screen_path: '',
  },
];

export interface ZoeChatSurfaceProps {
  messages: ZoeMessage[];
  conversations?: ZoeConversationListItem[];
  activeConversationId?: string | null;
  roles?: readonly string[];
  generatedBy?: string | null;
  morningBrief?: ZoeMorningBriefPayload | null;
  notes?: ZoeNoteItem[];
  glossaryEntries?: ZoeGlossaryEntry[];
  isLoading: boolean;
  isHistoryLoading?: boolean;
  streamingText?: string | null;
  statusLine?: string | null;
  researchMode?: boolean;
  researchPlanSteps?: string[];
  errorMessage?: string | null;
  remainingQuestionsToday?: number | null;
  onToggleResearchMode?: (nextValue: boolean) => void;
  onSendMessage: (prompt: string) => void | Promise<void>;
  onStopGenerating?: () => void;
  onRegenerate?: () => void | Promise<void>;
  onSelectConversation?: (conversationId: string) => void | Promise<void>;
  onStartNewChat?: () => void | Promise<void>;
  onRenameConversation?: (conversationId: string, title: string) => void | Promise<void>;
  onDeleteConversation?: (conversationId: string) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  onFeedback: (
    messageId: string,
    rating: ZoeFeedbackRating,
    options?: { comment?: string; reportKind?: 'rating' | 'problem_report' },
  ) => void | Promise<void>;
  onClearHistory: () => void | Promise<void>;
  onAddNote?: (noteText: string) => Promise<{ ok: boolean; error?: string }>;
  onDeleteNote?: (noteId: string) => Promise<{ ok: boolean; error?: string }>;
  onSaveGlossaryEntry?: (input: ZoeGlossaryUpsertInput) => Promise<{ ok: boolean; error?: string }>;
  onSendEmail?: (input: SendZoeReportEmailInput) => Promise<SendZoeReportEmailResponse>;
  onConfirmReminder?: (input: ConfirmZoeReminderInput) => Promise<ConfirmZoeActionResult>;
  onConfirmNotification?: (input: ConfirmZoeNotificationInput) => Promise<ConfirmZoeActionResult>;
  onConfirmSchedule?: (input: ConfirmZoeScheduleInput) => Promise<ConfirmZoeScheduleResult>;
  onConfirmIdea?: (input: ConfirmZoeIdeaInput) => Promise<ConfirmZoeActionResult>;
  onCancelReminder?: (reminderId: string) => Promise<ConfirmZoeActionResult>;
  onCancelSchedule?: (scheduleId: string) => Promise<ConfirmZoeActionResult>;
  onUpdateMorningBriefPrefs?: (input: {
    enabled: boolean;
    brief_time?: string;
    dismiss_today?: boolean;
  }) => Promise<ConfirmZoeActionResult>;
  onRefreshMorningBrief?: (force?: boolean) => Promise<ZoeMorningBriefPayload | null>;
  headerSlot?: React.ReactNode;
  renderMessageAction?: (message: ZoeMessage) => React.ReactNode;
  compact?: boolean;
  className?: string;
}

type ConfirmZoeScheduleResult = ConfirmZoeActionResult;

/**
 * Strips a trailing `Source: ... · Period: ...` line from the message body when we
 * already render the structured Source · dates footer underneath the answer.
 */
function parseMessageBodyAndMeta(msg: ZoeMessage): {
  bodyText: string;
  sourceLabel: string | null;
  periodLabel: string | null;
} {
  let bodyText = msg.content.trim();
  let sourceLabel = msg.source ?? null;
  let periodLabel = msg.period ?? null;

  const citationMatch = bodyText.match(/\n*\s*Source:\s*([^\n·]+?)\s*·\s*Period:\s*([^\n]+)$/i);
  if (citationMatch) {
    if (!sourceLabel) sourceLabel = citationMatch[1].trim();
    if (!periodLabel) periodLabel = citationMatch[2].trim();
    bodyText = bodyText.slice(0, citationMatch.index).trim();
  }

  return { bodyText, sourceLabel, periodLabel };
}

function extractRawDataRows(reportPayload?: Record<string, unknown> | null): Array<Record<string, unknown>> {
  if (!reportPayload || typeof reportPayload !== 'object') return [];
  const candidates = [
    reportPayload.rows,
    reportPayload.views,
    reportPayload.by_stage,
    reportPayload.buckets,
    reportPayload.requisition_disbursements,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) {
      return c.filter((r) => r && typeof r === 'object' && !Array.isArray(r)) as Array<
        Record<string, unknown>
      >;
    }
  }
  return [];
}

function extractAnalystMeta(reportPayload?: Record<string, unknown> | null): {
  isAdHoc: boolean;
  certification: string | null;
  executedSql: string | null;
  truncated: boolean;
} {
  if (!reportPayload || typeof reportPayload !== 'object') {
    return { isAdHoc: false, certification: null, executedSql: null, truncated: false };
  }
  const isAdHoc =
    reportPayload.ad_hoc === true ||
    reportPayload.tool === 'run_analyst_query' ||
    reportPayload.tool === 'get_data_catalog';
  const certification =
    typeof reportPayload.certification === 'string' && reportPayload.certification.trim()
      ? reportPayload.certification.trim()
      : isAdHoc
      ? 'Ad hoc, not certified'
      : null;
  const executedSql =
    typeof reportPayload.executed_sql === 'string' && reportPayload.executed_sql.trim()
      ? reportPayload.executed_sql.trim()
      : typeof reportPayload.sql === 'string' && reportPayload.sql.trim()
      ? reportPayload.sql.trim()
      : null;
  const truncated = reportPayload.truncated === true;
  return { isAdHoc, certification, executedSql, truncated };
}

function isCoarseOrMobileViewport(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(pointer: coarse)').matches) return true;
    }
    if (typeof window.innerWidth === 'number' && window.innerWidth > 0 && window.innerWidth < 768) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export const ZoeChatSurface: React.FC<ZoeChatSurfaceProps> = ({
  messages,
  conversations = [],
  activeConversationId = null,
  roles = [],
  generatedBy = null,
  morningBrief = null,
  notes = [],
  glossaryEntries = [],
  isLoading,
  isHistoryLoading = false,
  streamingText = null,
  statusLine = null,
  researchMode,
  researchPlanSteps = [],
  errorMessage = null,
  remainingQuestionsToday = null,
  onToggleResearchMode,
  onSendMessage,
  onStopGenerating,
  onRegenerate,
  onSelectConversation,
  onStartNewChat,
  onRenameConversation,
  onDeleteConversation,
  onRetry,
  onFeedback,
  onClearHistory,
  onAddNote,
  onDeleteNote,
  onSaveGlossaryEntry,
  onSendEmail,
  onConfirmReminder,
  onConfirmNotification,
  onConfirmSchedule,
  onConfirmIdea,
  onCancelReminder,
  onCancelSchedule,
  onUpdateMorningBriefPrefs,
  onRefreshMorningBrief,
  headerSlot,
  renderMessageAction,
  compact = false,
  className,
}) => {
  const [draft, setDraft] = useState('');
  const [internalResearchMode, setInternalResearchMode] = useState(false);
  const activeResearchMode =
    typeof researchMode === 'boolean' ? researchMode : internalResearchMode;
  const handleToggleResearch = () => {
    const next = !activeResearchMode;
    setInternalResearchMode(next);
    onToggleResearchMode?.(next);
  };
  const [showTopMoreMenu, setShowTopMoreMenu] = useState(false);
  const [showConversationList, setShowConversationList] = useState(false);
  const [showNotesDrawer, setShowNotesDrawer] = useState(false);
  const [showGlossaryDrawer, setShowGlossaryDrawer] = useState(false);
  const [noteDraft, setNoteDraft] = useState('');
  const [noteError, setNoteError] = useState<string | null>(null);
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [glossaryTermKey, setGlossaryTermKey] = useState('');
  const [glossaryTermTitle, setGlossaryTermTitle] = useState('');
  const [glossaryCategory, setGlossaryCategory] = useState<
    'definition' | 'measurement_gotcha' | 'accounting_policy' | 'operations'
  >('measurement_gotcha');
  const [glossaryDefinition, setGlossaryDefinition] = useState('');
  const [glossaryGotcha, setGlossaryGotcha] = useState('');
  const [glossarySourceNote, setGlossarySourceNote] = useState('');
  const [glossarySaveStatus, setGlossarySaveStatus] = useState<string | null>(null);
  const [editingConvId, setEditingConvId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [expandedDataIds, setExpandedDataIds] = useState<Record<string, boolean>>({});
  const [openMoreMenuMsgId, setOpenMoreMenuMsgId] = useState<string | null>(null);
  const [activeFeedbackFormId, setActiveFeedbackFormId] = useState<string | null>(null);
  const [feedbackReportKind, setFeedbackReportKind] = useState<'rating' | 'problem_report'>('rating');
  const [feedbackCommentDraft, setFeedbackCommentDraft] = useState('');
  const [submittedProblemIds, setSubmittedProblemIds] = useState<Record<string, boolean>>({});
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Deliverable (5): Starter prompts only on an empty chat — at most three, chosen from role and recent topics
  const starterSuggestions: ZoeSuggestion[] = useMemo(() => {
    const recentTopics = conversations.slice(0, 5).map((c) => c.title);
    return getStarterSuggestionsForRoles(roles, recentTopics, 3).slice(0, 3);
  }, [roles, conversations]);

  const canManageGlossary = roles.some((r) => GLOSSARY_MANAGER_ROLES.has(r.toLowerCase()));
  const activeGlossaryEntries =
    glossaryEntries.length > 0 ? glossaryEntries : DEFAULT_WELILE_GLOSSARY_ENTRIES;

  useEffect(() => {
    if (typeof endOfMessagesRef.current?.scrollIntoView === 'function') {
      endOfMessagesRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, isLoading, streamingText, errorMessage]);

  const syncTextareaHeight = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    // Up to 6 lines (~144px)
    const nextHeight = Math.min(Math.max(el.scrollHeight, 44), 144);
    el.style.height = `${nextHeight}px`;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!trimmed || isLoading) return;
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.style.height = '44px';
    }
    await onSendMessage(trimmed);
  };

  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Deliverable (6): Enter sends on desktop; on mobile/coarse pointer Enter makes a new line
      if (isCoarseOrMobileViewport()) {
        return;
      }
      e.preventDefault();
      const trimmed = draft.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!trimmed || isLoading) return;
      setDraft('');
      if (textareaRef.current) {
        textareaRef.current.style.height = '44px';
      }
      void onSendMessage(trimmed);
    }
  };

  const handleAddNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = noteDraft.trim();
    if (!trimmed || !onAddNote || isSavingNote) return;
    setNoteError(null);
    setIsSavingNote(true);
    try {
      const res = await onAddNote(trimmed);
      if (res.ok) {
        setNoteDraft('');
      } else {
        setNoteError(
          res.error ||
            'Zoe notes can only store short personal preferences (no UGX figures, account balances, or personal details about others).',
        );
      }
    } finally {
      setIsSavingNote(false);
    }
  };

  const handleSaveGlossarySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!onSaveGlossaryEntry || !canManageGlossary) return;
    setGlossarySaveStatus(null);
    const res = await onSaveGlossaryEntry({
      slug: glossaryTermKey.trim(),
      term: glossaryTermTitle.trim(),
      category: glossaryCategory,
      plain_definition: glossaryDefinition.trim(),
      measurement_gotcha: glossaryGotcha.trim(),
      official_source: glossarySourceNote.trim(),
    });
    if (res.ok) {
      setGlossarySaveStatus('Saved glossary entry.');
      setGlossaryTermKey('');
      setGlossaryTermTitle('');
      setGlossaryDefinition('');
      setGlossaryGotcha('');
      setGlossarySourceNote('');
    } else {
      setGlossarySaveStatus(res.error || 'Could not save glossary entry.');
    }
  };

  const handleSuggestionClick = async (prompt: string) => {
    if (isLoading) return;
    await onSendMessage(prompt);
  };

  const handleCopyMessage = async (msgId: string, text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      }
      setCopiedMessageId(msgId);
      setTimeout(() => {
        setCopiedMessageId((prev) => (prev === msgId ? null : prev));
      }, 2000);
    } catch {
      /* ignore clipboard error */
    }
  };

  const toggleShowData = (msgId: string) => {
    setExpandedDataIds((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id ?? null;

  const renderConversationItems = (includeTestIds: boolean) => {
    if (conversations.length === 0) {
      return (
        <p className="py-2 text-xs text-muted-foreground">
          No saved conversations yet. Ask a question below to start.
        </p>
      );
    }

    return (
      <div className="space-y-1.5">
        {conversations.map((conv) => {
          const isEditing = editingConvId === conv.id;
          const isActive = activeConversationId === conv.id;
          return (
            <div
              key={conv.id}
              data-testid={includeTestIds ? `zoe-conv-item-${conv.id}` : undefined}
              className={cn(
                'flex flex-wrap items-center justify-between gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors',
                isActive
                  ? 'border-primary/40 bg-primary/10 text-foreground font-medium'
                  : 'border-border/70 bg-background text-foreground hover:bg-muted/50',
              )}
            >
              {isEditing ? (
                <div className="flex flex-1 items-center gap-1.5 min-w-0">
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    maxLength={120}
                    aria-label="Conversation title"
                    data-testid={includeTestIds ? `zoe-conv-rename-input-${conv.id}` : undefined}
                    className="min-h-[44px] min-w-0 flex-1 rounded border border-input bg-background px-2.5 py-1 text-xs text-foreground"
                  />
                  <button
                    type="button"
                    data-testid={includeTestIds ? `zoe-conv-rename-save-${conv.id}` : undefined}
                    onClick={() => {
                      if (renameDraft.trim() && onRenameConversation) {
                        void onRenameConversation(conv.id, renameDraft.trim());
                      }
                      setEditingConvId(null);
                      setRenameDraft('');
                    }}
                    className="inline-flex min-h-[44px] items-center rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setShowConversationList(false);
                      if (onSelectConversation) {
                        void onSelectConversation(conv.id);
                      }
                    }}
                    className="min-h-[44px] flex-1 truncate text-left text-xs font-medium text-foreground hover:underline"
                  >
                    {conv.title || 'New chat'}
                  </button>
                  <div className="flex shrink-0 items-center gap-0.5">
                    {onRenameConversation && (
                      <button
                        type="button"
                        aria-label={`Rename ${conv.title || 'chat'}`}
                        data-testid={includeTestIds ? `zoe-conv-rename-btn-${conv.id}` : undefined}
                        onClick={() => {
                          setEditingConvId(conv.id);
                          setRenameDraft(conv.title || '');
                        }}
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                    {onDeleteConversation && (
                      <button
                        type="button"
                        aria-label={`Delete ${conv.title || 'chat'}`}
                        data-testid={includeTestIds ? `zoe-conv-delete-btn-${conv.id}` : undefined}
                        onClick={() => {
                          void onDeleteConversation(conv.id);
                        }}
                        className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      data-testid="zoe-chat-surface"
      className={cn(
        'relative flex w-full min-w-0 bg-background text-foreground',
        compact ? 'h-[100dvh]' : 'min-h-[calc(100dvh-5rem)]',
        className,
      )}
    >
      {/* Deliverable (8): Slim history rail on desktop (1024px and up) */}
      {!compact && (
        <aside
          data-testid="zoe-conversations-rail"
          aria-label="Recent conversations"
          className="hidden lg:flex lg:w-60 lg:shrink-0 lg:flex-col lg:border-r lg:border-border/70 lg:bg-muted/15"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-3 py-2.5">
            <span className="text-xs font-semibold text-foreground">Chats</span>
            {onStartNewChat && (
              <button
                type="button"
                onClick={() => void onStartNewChat()}
                disabled={isLoading}
                aria-label="Start new chat from rail"
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-2.5">
            {renderConversationItems(!showConversationList)}
          </div>
        </aside>
      )}

      {/* Main conversation column */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Deliverable (2): Top bar — Title "Zoe", history icon, new-chat icon, and "..." menu */}
        <header className="sticky top-0 z-20 border-b border-border/60 bg-background/95 backdrop-blur">
          <div className="mx-auto flex w-full max-w-[720px] items-center justify-between gap-2 px-4 py-2">
            <div className="flex min-w-0 items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowConversationList((prev) => !prev);
                  setShowNotesDrawer(false);
                  setShowGlossaryDrawer(false);
                  setShowTopMoreMenu(false);
                }}
                data-testid="zoe-conversations-toggle"
                aria-label="Chat history"
                aria-expanded={showConversationList}
                title="Chat history"
                className={cn(
                  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  showConversationList && 'bg-muted text-foreground',
                )}
              >
                <History className="h-4 w-4 shrink-0" aria-hidden="true" />
              </button>

              <h2 className="truncate text-base font-semibold tracking-tight text-foreground">
                Zoe
              </h2>

              {/* Deliverable (2): Show daily counter in main view ONLY when 10 or fewer remain */}
              {typeof remainingQuestionsToday === 'number' && remainingQuestionsToday <= 10 && (
                <span
                  data-testid="zoe-low-quota-badge"
                  className="rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300"
                >
                  {remainingQuestionsToday} left today
                </span>
              )}
            </div>

            <div className="relative flex items-center gap-1">
              {onStartNewChat && (
                <button
                  type="button"
                  onClick={() => {
                    setShowConversationList(false);
                    setShowTopMoreMenu(false);
                    void onStartNewChat();
                  }}
                  disabled={isLoading}
                  data-testid="zoe-new-chat-button"
                  aria-label="New chat"
                  title="New chat"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <MessageSquarePlus className="h-4 w-4 shrink-0" aria-hidden="true" />
                </button>
              )}

              <button
                type="button"
                data-testid="zoe-top-more-button"
                aria-label="More options"
                aria-expanded={showTopMoreMenu}
                aria-haspopup="menu"
                title="More options"
                onClick={() => setShowTopMoreMenu((prev) => !prev)}
                className={cn(
                  'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  showTopMoreMenu && 'bg-muted text-foreground',
                )}
              >
                <MoreHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
              </button>

              {/* Deliverable (2): "..." menu holding Zoe notes, Glossary, Full view, Clear my history, and daily counter */}
              <div
                role="menu"
                aria-label="Zoe options menu"
                data-testid="zoe-top-more-menu"
                data-state={showTopMoreMenu ? 'open' : 'closed'}
                hidden={!showTopMoreMenu}
                className={cn(
                  'absolute right-0 top-12 z-30 w-56 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg',
                  !showTopMoreMenu && 'hidden',
                )}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowNotesDrawer((prev) => !prev);
                    setShowGlossaryDrawer(false);
                    setShowConversationList(false);
                    setShowTopMoreMenu(false);
                  }}
                  data-testid="zoe-notes-toggle"
                  aria-expanded={showNotesDrawer}
                  className="flex min-h-[44px] w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <span className="inline-flex items-center gap-2">
                    <Bookmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>Zoe notes ({notes.length})</span>
                  </span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowGlossaryDrawer((prev) => !prev);
                    setShowNotesDrawer(false);
                    setShowConversationList(false);
                    setShowTopMoreMenu(false);
                  }}
                  data-testid="zoe-glossary-toggle"
                  aria-expanded={showGlossaryDrawer}
                  className="flex min-h-[44px] w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
                >
                  <span className="inline-flex items-center gap-2">
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span>Glossary</span>
                  </span>
                </button>

                {headerSlot ? (
                  <div
                    role="menuitem"
                    data-testid="zoe-full-view-slot"
                    onClick={() => setShowTopMoreMenu(false)}
                    className="flex min-h-[44px] w-full items-center rounded-lg px-2 py-1 text-xs text-foreground hover:bg-muted"
                  >
                    {headerSlot}
                  </div>
                ) : (
                  <Link
                    to="/me/zoe"
                    role="menuitem"
                    data-testid="zoe-full-view-link"
                    onClick={() => setShowTopMoreMenu(false)}
                    className="flex min-h-[44px] w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    <span className="inline-flex items-center gap-2">
                      <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span>Full view</span>
                    </span>
                  </Link>
                )}

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setShowTopMoreMenu(false);
                    void onClearHistory();
                  }}
                  disabled={isLoading || (messages.length === 0 && !errorMessage)}
                  data-testid="zoe-clear-history"
                  className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span>Clear my history</span>
                </button>

                {typeof remainingQuestionsToday === 'number' && (
                  <>
                    <div className="my-1 border-t border-border/60" />
                    <div
                      data-testid="zoe-menu-quota"
                      className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground"
                    >
                      <span>Daily quota</span>
                      <span className="font-medium text-foreground">
                        {remainingQuestionsToday} left today
                      </span>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Collapsible Zoe Notes Drawer (up to 20 short personal preferences; never business figures or PII) */}
        {showNotesDrawer && (
          <div
            data-testid="zoe-notes-drawer"
            className="border-b border-border bg-muted/25 px-4 py-3"
          >
            <div className="mx-auto max-w-[720px] space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    Your Zoe Notes ({notes.length}/{MAX_ZOE_NOTES})
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Short preferences Zoe remembers across chats (e.g. &ldquo;Show Kampala West first&rdquo;). Never store UGX figures or personal data about others.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowNotesDrawer(false)}
                  aria-label="Close Zoe notes"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              {onAddNote && (
                <form
                  onSubmit={(e) => void handleAddNoteSubmit(e)}
                  className="flex flex-wrap items-center gap-2"
                >
                  <input
                    type="text"
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    maxLength={160}
                    placeholder="Add a short preference (max 160 chars)..."
                    aria-label="New Zoe note"
                    data-testid="zoe-note-input"
                    className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-xs text-foreground"
                  />
                  <button
                    type="submit"
                    disabled={!noteDraft.trim() || isSavingNote || notes.length >= MAX_ZOE_NOTES}
                    data-testid="zoe-note-add-button"
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Save note</span>
                  </button>
                </form>
              )}

              {noteError && (
                <p
                  role="alert"
                  data-testid="zoe-note-error"
                  className="rounded-lg border border-border bg-muted/60 px-3 py-2 text-xs text-foreground"
                >
                  {noteError}
                </p>
              )}

              {notes.length === 0 ? (
                <p className="py-1 text-xs text-muted-foreground">No saved Zoe notes yet.</p>
              ) : (
                <div className="max-h-48 space-y-1.5 overflow-y-auto">
                  {notes.map((n) => (
                    <div
                      key={n.id}
                      data-testid={`zoe-note-item-${n.id}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
                    >
                      <span className="min-w-0 flex-1 break-words">{n.note_text}</span>
                      {onDeleteNote && (
                        <button
                          type="button"
                          aria-label={`Delete note ${n.note_text}`}
                          data-testid={`zoe-note-delete-${n.id}`}
                          onClick={() => void onDeleteNote(n.id)}
                          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-border bg-background px-2 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Collapsible Welile Glossary Drawer + Manager Screen (never editable through Zoe chat) */}
        {showGlossaryDrawer && (
          <div
            data-testid="zoe-glossary-drawer"
            className="border-b border-border bg-muted/25 px-4 py-3"
          >
            <div className="mx-auto max-w-[720px] space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                    Welile Glossary &amp; Measurement Gotchas
                  </span>
                  <p className="text-xs text-muted-foreground">
                    Official definitions Zoe uses via get_welile_glossary so figures and terms stay accurate.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowGlossaryDrawer(false)}
                  aria-label="Close glossary"
                  className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>

              <div className="max-h-56 space-y-2 overflow-y-auto">
                {activeGlossaryEntries.map((entry) => (
                  <div
                    key={entry.slug}
                    data-testid={`zoe-glossary-item-${entry.slug}`}
                    className="space-y-1 rounded-lg border border-border bg-background p-2.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1.5">
                      <span className="font-semibold text-foreground">{entry.term}</span>
                      <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {entry.category.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="leading-relaxed text-foreground">{entry.plain_definition}</p>
                    {entry.measurement_gotcha && (
                      <p className="leading-relaxed text-muted-foreground">
                        <span className="font-semibold text-foreground">Measurement gotcha: </span>
                        {entry.measurement_gotcha}
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {canManageGlossary && onSaveGlossaryEntry && (
                <form
                  onSubmit={(e) => void handleSaveGlossarySubmit(e)}
                  data-testid="zoe-glossary-manager-form"
                  className="space-y-2 rounded-lg border border-border bg-background p-3"
                >
                  <p className="text-xs font-semibold text-foreground">
                    Manager Glossary Editor (updates staff_assistant_glossary directly)
                  </p>
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                    <input
                      type="text"
                      value={glossaryTermKey}
                      onChange={(e) => setGlossaryTermKey(e.target.value)}
                      placeholder="term_key (e.g. expected_vs_collected)"
                      aria-label="Glossary term key"
                      data-testid="zoe-glossary-key-input"
                      className="min-h-[44px] rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                    />
                    <input
                      type="text"
                      value={glossaryTermTitle}
                      onChange={(e) => setGlossaryTermTitle(e.target.value)}
                      placeholder="Term title"
                      aria-label="Glossary term title"
                      data-testid="zoe-glossary-title-input"
                      className="min-h-[44px] rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                    />
                    <select
                      value={glossaryCategory}
                      onChange={(e) =>
                        setGlossaryCategory(
                          e.target.value as
                            | 'definition'
                            | 'measurement_gotcha'
                            | 'accounting_policy'
                            | 'operations',
                        )
                      }
                      aria-label="Glossary category"
                      data-testid="zoe-glossary-category-select"
                      className="min-h-[44px] rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                    >
                      <option value="measurement_gotcha">Measurement gotcha</option>
                      <option value="definition">Definition</option>
                      <option value="accounting_policy">Accounting policy</option>
                      <option value="operations">Operations</option>
                    </select>
                  </div>
                  <input
                    type="text"
                    value={glossaryDefinition}
                    onChange={(e) => setGlossaryDefinition(e.target.value)}
                    placeholder="Official definition..."
                    aria-label="Glossary definition"
                    data-testid="zoe-glossary-definition-input"
                    className="min-h-[44px] w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                  />
                  <input
                    type="text"
                    value={glossaryGotcha}
                    onChange={(e) => setGlossaryGotcha(e.target.value)}
                    placeholder="Measurement gotcha (optional)..."
                    aria-label="Glossary measurement gotcha"
                    data-testid="zoe-glossary-gotcha-input"
                    className="min-h-[44px] w-full rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <input
                      type="text"
                      value={glossarySourceNote}
                      onChange={(e) => setGlossarySourceNote(e.target.value)}
                      placeholder="Source note (optional)..."
                      aria-label="Glossary source note"
                      className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground"
                    />
                    <button
                      type="submit"
                      disabled={
                        !glossaryTermKey.trim() ||
                        !glossaryTermTitle.trim() ||
                        !glossaryDefinition.trim()
                      }
                      data-testid="zoe-glossary-save-button"
                      className="inline-flex min-h-[44px] items-center rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
                    >
                      Save term
                    </button>
                  </div>
                  {glossarySaveStatus && (
                    <p data-testid="zoe-glossary-save-status" className="text-xs text-muted-foreground">
                      {glossarySaveStatus}
                    </p>
                  )}
                </form>
              )}
            </div>
          </div>
        )}

        {/* Deliverable (8): Left slide-over history drawer on phones (and when toggled from top bar) */}
        {showConversationList && (
          <div
            data-testid="zoe-conversation-drawer"
            className="border-b border-border bg-muted/25 px-4 py-3"
          >
            <div className="mx-auto max-w-[720px] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recent Conversations
                </span>
                <div className="flex items-center gap-1">
                  {onStartNewChat && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowConversationList(false);
                        void onStartNewChat();
                      }}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/10"
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Start new chat</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowConversationList(false)}
                    aria-label="Close recent conversations"
                    className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              </div>

              <div className="max-h-56 overflow-y-auto">
                {renderConversationItems(true)}
              </div>
            </div>
          </div>
        )}

        {/* Deliverable (1): One centred column, max width 720px on desktop, full width with 16px (px-4) sides on a phone */}
        <div
          className="flex-1 overflow-y-auto"
          role="log"
          aria-live="polite"
          aria-label="Zoe conversation messages"
        >
          <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5 px-4 py-5">
            {/* Optional 07:30 Kampala Morning Brief (off by default, turned on per person) */}
            {morningBrief && (
              <ZoeMorningBriefCard
                brief={morningBrief}
                onUpdatePrefs={onUpdateMorningBriefPrefs}
                onRefreshBrief={onRefreshMorningBrief}
              />
            )}

            {isHistoryLoading && messages.length === 0 ? (
              <div
                data-testid="zoe-history-loading"
                className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground"
              >
                <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
                <span>Loading your recent conversation...</span>
              </div>
            ) : null}

            {/* Deliverable (5): Empty state with at most THREE starter prompts */}
            {!isHistoryLoading && messages.length === 0 && !isLoading && !errorMessage ? (
              <div
                data-testid="zoe-empty-state"
                className="my-auto flex flex-col items-center justify-center py-8 text-center"
              >
                <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Sparkles className="h-5 w-5" aria-hidden="true" />
                </div>
                <h3 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
                  What would you like to check?
                </h3>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground sm:text-sm">
                  Zoe reads only the official Welile database functions your role is permitted to access. Every answer cites the exact data source and period.
                </p>

                <div
                  data-testid="zoe-suggestion-list"
                  className="mt-6 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-3"
                >
                  {starterSuggestions.map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      data-testid={`zoe-suggestion-${chip.id}`}
                      onClick={() => void handleSuggestionClick(chip.prompt)}
                      className="flex min-h-[44px] flex-col justify-between rounded-xl border border-border bg-background px-3.5 py-3 text-left text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span>{chip.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {/* Conversation turns */}
            {messages.map((msg, msgIdx) => {
              if (msg.role === 'user') {
                // Deliverable (3): User message — right-aligned purple bubble
                return (
                  <div
                    key={msg.id}
                    data-testid="zoe-user-message"
                    className="flex justify-end"
                  >
                    <div className="max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-xs leading-relaxed text-primary-foreground sm:max-w-[75%] sm:text-sm">
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    </div>
                  </div>
                );
              }

              const precedingUserPrompt =
                messages
                  .slice(0, msgIdx)
                  .reverse()
                  .find((m) => m.role === 'user')?.content ?? '';

              const { bodyText, sourceLabel, periodLabel } = parseMessageBodyAndMeta(msg);
              const hasSourceMeta = Boolean(sourceLabel || periodLabel);
              const screenLink = hasSourceMeta ? resolveSourceScreenLink(sourceLabel) : null;
              const fileDecision = evaluateZoeFileRequest({
                userPrompt: precedingUserPrompt,
                assistantMessage: msg,
                options: {
                  generatedBy,
                  generatedAt: msg.createdAt,
                  userQuestion: precedingUserPrompt,
                },
              });
              const exportableReport = fileDecision.report;
              const chartData = extractZoeChartFromMessage(msg.reportPayload);
              const rawRows = extractRawDataRows(msg.reportPayload);
              const analystMeta = extractAnalystMeta(msg.reportPayload);
              const canShowData = rawRows.length > 0 || Boolean(analystMeta.executedSql);
              const isDataExpanded = Boolean(expandedDataIds[msg.id]);
              const emailDraft = extractZoeEmailDraft(msg);
              const actionDraft = extractZoeActionDraft(msg);
              const remindersAndSchedules = extractZoeRemindersAndSchedules(msg);
              const followUps =
                msg.followUpSuggestions && msg.followUpSuggestions.length > 0
                  ? msg.followUpSuggestions
                  : Array.isArray(msg.reportPayload?.follow_up_suggestions)
                  ? (msg.reportPayload?.follow_up_suggestions as string[])
                  : [];
              const isLatestAssistant = msg.id === lastAssistantId;
              const isMoreMenuOpen = openMoreMenuMsgId === msg.id;

              // Deliverable (3): Zoe's message — NO bubble, full width, readable line length, proper Markdown
              return (
                <article
                  key={msg.id}
                  data-testid="zoe-assistant-message"
                  className="group flex w-full flex-col items-start space-y-2.5 py-1 text-foreground"
                >
                  <div className="w-full space-y-2.5">
                    <ZoeMarkdown content={bodyText} />

                    {/* Deliverable (3): Charts are small and inline */}
                    {chartData && <ZoeMiniChart chart={chartData} />}

                    {exportableReport && !remindersAndSchedules && (
                      <ZoeReportCard
                        report={exportableReport}
                        initialFileReady={fileDecision.fileCreated}
                        requestedFormat={fileDecision.requestedFormat}
                      />
                    )}
                    {emailDraft && (
                      <ZoeEmailDraftCard
                        draft={emailDraft}
                        report={exportableReport}
                        messageId={msg.id}
                        onSendEmail={onSendEmail}
                      />
                    )}
                    {actionDraft && (
                      <ZoeActionDraftCard
                        draft={actionDraft}
                        conversationId={activeConversationId}
                        messageId={msg.id}
                        onConfirmReminder={onConfirmReminder}
                        onConfirmNotification={onConfirmNotification}
                        onConfirmSchedule={onConfirmSchedule}
                        onConfirmIdea={onConfirmIdea}
                      />
                    )}
                    {remindersAndSchedules && (
                      <ZoeSchedulesAndRemindersCard
                        data={remindersAndSchedules}
                        onCancelReminder={onCancelReminder}
                        onCancelSchedule={onCancelSchedule}
                      />
                    )}

                    {/* Deliverable (3): Collapsible "Show the data" raw table view + executed Analyst SQL with sticky first column */}
                    {isDataExpanded && canShowData && (
                      <div
                        data-testid={`zoe-show-data-panel-${msg.id}`}
                        className="my-2 space-y-2"
                      >
                        {analystMeta.executedSql && (
                          <div
                            data-testid={`zoe-executed-sql-${msg.id}`}
                            className="overflow-x-auto rounded-lg border border-border bg-background p-2.5 text-xs"
                          >
                            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                              <span className="font-semibold text-foreground">
                                Executed SQL (zoe_ro read-only)
                              </span>
                              <span
                                data-testid={`zoe-adhoc-badge-${msg.id}`}
                                className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                              >
                                {analystMeta.certification ?? 'Ad hoc, not certified'}
                                {analystMeta.truncated ? ' · truncated to 500 rows' : ''}
                              </span>
                            </div>
                            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/40 p-2 font-mono text-xs text-foreground">
                              <code>{analystMeta.executedSql}</code>
                            </pre>
                          </div>
                        )}

                        {rawRows.length > 0 && (
                          <div
                            data-testid={`zoe-raw-data-table-${msg.id}`}
                            className="max-h-64 w-full overflow-auto rounded-lg border border-border bg-background"
                          >
                            <table className="w-full min-w-[320px] border-collapse text-left text-xs">
                              <thead>
                                <tr className="border-b border-border bg-muted/60">
                                  {Object.keys(rawRows[0]).map((col) => (
                                    <th
                                      key={col}
                                      className="whitespace-nowrap px-2.5 py-2 font-semibold text-foreground first:sticky first:left-0 first:z-10 first:border-r first:border-border/70 first:bg-muted/95"
                                    >
                                      {col.replace(/_/g, ' ')}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/70">
                                {rawRows.slice(0, 50).map((r, rIdx) => (
                                  <tr key={rIdx} className="hover:bg-muted/30">
                                    {Object.keys(rawRows[0]).map((col) => (
                                      <td
                                        key={col}
                                        className="whitespace-nowrap px-2.5 py-1.5 text-xs text-foreground first:sticky first:left-0 first:z-10 first:border-r first:border-border/70 first:bg-background/95 first:font-medium"
                                      >
                                        {r[col] === null || r[col] === undefined ? '—' : String(r[col])}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Clarifying options when Zoe calls ask_clarification */}
                    {msg.clarification?.options && msg.clarification.options.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {msg.clarification.options.map((option) => (
                          <button
                            key={option}
                            type="button"
                            disabled={isLoading}
                            onClick={() => void handleSuggestionClick(option)}
                            className="inline-flex min-h-[44px] items-center rounded-lg border border-primary/30 bg-background px-3 py-2 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          >
                            {option}
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Source · dates citation + link to the matching screen */}
                    {hasSourceMeta && (
                      <div
                        data-testid="zoe-source-line"
                        className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs text-muted-foreground"
                      >
                        <span className="min-w-0 break-words">
                          Source: {sourceLabel ?? 'Official report'}
                          {periodLabel ? ` · ${periodLabel}` : ''}
                        </span>
                        {screenLink && (
                          <Link
                            to={screenLink.to}
                            data-testid="zoe-screen-link"
                            className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary underline-offset-4 hover:bg-primary/10 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <span>{screenLink.label}</span>
                            <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          </Link>
                        )}
                      </div>
                    )}

                    {/* Deliverable (4): Four subtle action icons (Copy, Thumbs up, Thumbs down, "..." menu) */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div
                        data-testid={`zoe-message-actions-${msg.id}`}
                        className={cn(
                          'relative flex items-center gap-0.5 transition-opacity',
                          isLatestAssistant
                            ? 'opacity-80 lg:opacity-100'
                            : 'opacity-70 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100',
                        )}
                      >
                        <button
                          type="button"
                          data-testid={`zoe-copy-${msg.id}`}
                          aria-label={copiedMessageId === msg.id ? 'Copied' : 'Copy answer'}
                          title={copiedMessageId === msg.id ? 'Copied' : 'Copy answer'}
                          onClick={() => void handleCopyMessage(msg.id, msg.content)}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {copiedMessageId === msg.id ? (
                            <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                          ) : (
                            <Copy className="h-4 w-4" aria-hidden="true" />
                          )}
                        </button>

                        <button
                          type="button"
                          aria-label="Helpful answer"
                          aria-pressed={msg.feedback === 'up'}
                          title="Helpful answer"
                          data-testid={`zoe-feedback-up-${msg.id}`}
                          onClick={() => {
                            setActiveFeedbackFormId((prev) => (prev === msg.id ? null : prev));
                            void onFeedback(msg.id, 'up');
                          }}
                          className={cn(
                            'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            msg.feedback === 'up'
                              ? 'bg-primary/15 text-primary'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          aria-label="Not helpful answer"
                          aria-pressed={msg.feedback === 'down'}
                          title="Not helpful answer"
                          data-testid={`zoe-feedback-down-${msg.id}`}
                          onClick={() => {
                            setFeedbackReportKind('rating');
                            setActiveFeedbackFormId(msg.id);
                            void onFeedback(msg.id, 'down');
                          }}
                          className={cn(
                            'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            msg.feedback === 'down'
                              ? 'bg-muted text-foreground'
                              : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                          )}
                        >
                          <ThumbsDown className="h-4 w-4" aria-hidden="true" />
                        </button>

                        <button
                          type="button"
                          data-testid={`zoe-message-more-${msg.id}`}
                          aria-label="More message actions"
                          aria-expanded={isMoreMenuOpen}
                          aria-haspopup="menu"
                          title="More actions"
                          onClick={() =>
                            setOpenMoreMenuMsgId((prev) => (prev === msg.id ? null : msg.id))
                          }
                          className={cn(
                            'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            isMoreMenuOpen && 'bg-muted text-foreground',
                          )}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                        </button>

                        {/* Message "..." menu holding Regenerate, Report a problem, Show the data */}
                        <div
                          role="menu"
                          aria-label="Message actions menu"
                          data-testid={`zoe-message-more-menu-${msg.id}`}
                          data-state={isMoreMenuOpen ? 'open' : 'closed'}
                          hidden={!isMoreMenuOpen}
                          className={cn(
                            'absolute bottom-11 left-0 z-30 w-48 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg',
                            !isMoreMenuOpen && 'hidden',
                          )}
                        >
                          {isLatestAssistant && onRegenerate && (
                            <button
                              type="button"
                              role="menuitem"
                              disabled={isLoading}
                              data-testid={`zoe-regenerate-${msg.id}`}
                              onClick={() => {
                                setOpenMoreMenuMsgId(null);
                                void onRegenerate();
                              }}
                              className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
                            >
                              <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                              <span>Regenerate</span>
                            </button>
                          )}

                          {canShowData && (
                            <button
                              type="button"
                              role="menuitem"
                              data-testid={`zoe-show-data-${msg.id}`}
                              aria-expanded={isDataExpanded}
                              onClick={() => {
                                setOpenMoreMenuMsgId(null);
                                toggleShowData(msg.id);
                              }}
                              className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
                            >
                              <Database className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                              <span>{isDataExpanded ? 'Hide the data' : 'Show the data'}</span>
                            </button>
                          )}

                          <button
                            type="button"
                            role="menuitem"
                            data-testid={`zoe-report-problem-${msg.id}`}
                            onClick={() => {
                              setOpenMoreMenuMsgId(null);
                              setFeedbackReportKind('problem_report');
                              setActiveFeedbackFormId((prev) =>
                                prev === msg.id && feedbackReportKind === 'problem_report'
                                  ? null
                                  : msg.id,
                              );
                            }}
                            className="flex min-h-[44px] w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted"
                          >
                            <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                            <span>
                              {submittedProblemIds[msg.id] ? 'Problem reported' : 'Report a problem'}
                            </span>
                          </button>
                        </div>
                      </div>

                      {renderMessageAction ? renderMessageAction(msg) : null}
                    </div>

                    {activeFeedbackFormId === msg.id && (
                      <form
                        data-testid={`zoe-feedback-form-${msg.id}`}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const trimmedComment = feedbackCommentDraft.trim();
                          void onFeedback(msg.id, 'down', {
                            comment: trimmedComment || undefined,
                            reportKind: feedbackReportKind,
                          });
                          if (feedbackReportKind === 'problem_report') {
                            setSubmittedProblemIds((prev) => ({ ...prev, [msg.id]: true }));
                          }
                          setFeedbackCommentDraft('');
                          setActiveFeedbackFormId(null);
                        }}
                        className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5 text-xs"
                      >
                        <input
                          type="text"
                          value={feedbackCommentDraft}
                          onChange={(e) => setFeedbackCommentDraft(e.target.value.slice(0, 500))}
                          placeholder={
                            feedbackReportKind === 'problem_report'
                              ? 'Describe what went wrong or what figure/report was missing...'
                              : 'Optional: tell managers what was missing or unhelpful...'
                          }
                          aria-label="Feedback comment"
                          data-testid={`zoe-feedback-comment-input-${msg.id}`}
                          className="min-h-[44px] min-w-[200px] flex-1 rounded-lg border border-input bg-background px-2.5 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <button
                          type="submit"
                          data-testid={`zoe-feedback-submit-${msg.id}`}
                          className="inline-flex min-h-[44px] items-center rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          Send feedback
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setFeedbackCommentDraft('');
                            setActiveFeedbackFormId(null);
                          }}
                          className="inline-flex min-h-[44px] items-center rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
                        >
                          Cancel
                        </button>
                      </form>
                    )}

                    {/* Deliverable (5): At most THREE follow-up lines as quiet text links */}
                    {followUps.length > 0 && (
                      <div
                        data-testid={`zoe-follow-ups-${msg.id}`}
                        className="flex flex-col items-start gap-0.5 pt-0.5"
                      >
                        {followUps.slice(0, 3).map((q) => (
                          <button
                            key={q}
                            type="button"
                            disabled={isLoading}
                            onClick={() => void handleSuggestionClick(q)}
                            className="group/link inline-flex min-h-[44px] items-center gap-1.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                          >
                            <ArrowRight
                              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform group-hover/link:translate-x-0.5 group-hover/link:text-primary"
                              aria-hidden="true"
                            />
                            <span className="underline-offset-4 group-hover/link:underline">
                              {q}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </article>
              );
            })}

            {/* Deliverable (7): One quiet status line while working (plus Research plan steps when active) */}
            {isLoading && (
              <div
                role="status"
                aria-live="polite"
                data-testid="zoe-typing-indicator"
                className="flex flex-col items-start gap-2 py-1 text-xs text-muted-foreground"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
                  <span data-testid="zoe-live-status-line" className="truncate">
                    {statusLine || 'Zoe is reading official records...'}
                  </span>
                </div>
                {activeResearchMode && researchPlanSteps.length > 0 && (
                  <ol
                    data-testid="zoe-research-plan"
                    className="w-full space-y-1 rounded-xl border border-border bg-muted/40 p-2.5 text-xs text-muted-foreground"
                  >
                    {researchPlanSteps.map((step, idx) => (
                      <li key={step} className="flex items-start gap-1.5 leading-snug">
                        <span className="font-medium text-foreground">{idx + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                )}
                {streamingText && (
                  <div className="w-full pt-1 text-foreground">
                    <ZoeMarkdown content={streamingText} />
                  </div>
                )}
              </div>
            )}

            {/* Deliverable (7): Soft inline error note (never a red banner) with plain words and "Try again" link */}
            {errorMessage && (
              <div
                role="status"
                aria-live="polite"
                data-testid="zoe-error-banner"
                data-raw-error={errorMessage}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/50 px-3.5 py-2.5 text-xs text-foreground"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="break-words leading-relaxed">
                    {formatPlainZoeErrorMessage(errorMessage)}
                  </span>
                </div>
                {onRetry && (
                  <button
                    type="button"
                    data-testid="zoe-retry-button"
                    onClick={() => void onRetry()}
                    disabled={isLoading}
                    className="inline-flex min-h-[44px] shrink-0 items-center gap-1 px-2 text-xs font-semibold text-primary underline underline-offset-4 hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    <span>Try again</span>
                  </button>
                )}
              </div>
            )}

            <div ref={endOfMessagesRef} />
          </div>
        </div>

        {/* Deliverable (6) & Prompt 3 (4): Rounded auto-growing composer (up to 6 lines), Research toggle (off by default), circular Send / Stop button, disclaimer line, safe area */}
        <div className="sticky bottom-0 z-10 bg-background/95 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
          <div className="mx-auto w-full max-w-[720px] px-4">
            <form
              onSubmit={(e) => void handleSubmit(e)}
              data-research-mode={activeResearchMode ? 'true' : 'false'}
              className="flex items-end gap-2 rounded-3xl border border-border bg-muted/30 p-1.5 pl-3 shadow-xs transition-colors focus-within:border-primary/50 focus-within:bg-background"
            >
              <button
                type="button"
                onClick={handleToggleResearch}
                disabled={isLoading}
                aria-pressed={activeResearchMode}
                aria-label="Toggle Research mode"
                title={
                  activeResearchMode
                    ? 'Research mode is on (multi-step plan + cited sources)'
                    : 'Turn on Research mode for multi-step web and internal research'
                }
                data-testid="zoe-research-toggle"
                className={cn(
                  'inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                  activeResearchMode
                    ? 'border-primary/40 bg-primary/15 text-primary'
                    : 'border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>Research</span>
              </button>

              <label htmlFor="zoe-question-input" className="sr-only">
                Ask Zoe a question
              </label>
              <textarea
                id="zoe-question-input"
                ref={textareaRef}
                rows={1}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  syncTextareaHeight(e.target);
                }}
                onKeyDown={handleComposerKeyDown}
                maxLength={MAX_MESSAGE_LENGTH}
                disabled={isLoading}
                placeholder={
                  activeResearchMode ? 'Ask Zoe to research a topic...' : 'Message Zoe...'
                }
                data-testid="zoe-input"
                className="max-h-36 min-h-[44px] min-w-0 flex-1 resize-none bg-transparent py-2.5 text-xs leading-snug text-foreground placeholder:text-muted-foreground focus:outline-none sm:text-sm"
              />

              {isLoading && onStopGenerating ? (
                <button
                  type="button"
                  onClick={onStopGenerating}
                  data-testid="zoe-stop-button"
                  aria-label="Stop generating"
                  title="Stop generating"
                  className="inline-flex h-11 w-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground transition-colors hover:bg-secondary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Square className="h-4 w-4 fill-current" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isLoading || !draft.trim()}
                  data-testid="zoe-send-button"
                  aria-label="Send message"
                  title="Send message"
                  className="inline-flex h-11 w-11 min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
                </button>
              )}
            </form>

            <p
              data-testid="zoe-disclaimer-line"
              className="mt-1.5 text-center text-xs text-muted-foreground"
            >
              Zoe can make mistakes. Check important figures.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ZoeChatSurface;
