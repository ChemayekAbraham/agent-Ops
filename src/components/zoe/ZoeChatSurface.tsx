import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  BookOpen,
  Bookmark,
  Check,
  Copy,
  Database,
  Edit3,
  ExternalLink,
  History,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Square,
  ThumbsDown,
  ThumbsUp,
  Trash2,
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
  getSuggestionsForRoles,
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
    termKey: 'expected_vs_collected',
    termTitle: 'Expected vs Collected Repayments',
    category: 'measurement_gotcha',
    definition:
      'Expected is the contractual daily or period repayment due on active Rent Plans; Collected is verified cash/wallet inflows posted to the general ledger.',
    measurementGotcha:
      'Never subtract Collected from Total Disbursed to compute arrears; compare Collected against Expected Due to date on active plans.',
    sourceNote: 'assistant_staff_tenant_ops_overview · assistant_staff_cfo_collections_summary',
  },
  {
    termKey: 'treasury_cash_vs_wallet_liability',
    termTitle: 'Treasury Cash vs Wallet Liability',
    category: 'measurement_gotcha',
    definition:
      'Treasury cash is physical/bank/mobile-money cash held by Welile (A1–A3), whereas wallet balances are liabilities owed to users or earmarked operational float.',
    measurementGotcha:
      'A high wallet balance total is not free company cash; check Cash Position and CFO Overview for net available liquidity.',
    sourceNote: 'assistant_staff_cfo_cash_and_wallets · Cash Position',
  },
  {
    termKey: 'active_rent_plan_clock',
    termTitle: 'Active Rent Plan & Repayment Clock',
    category: 'measurement_gotcha',
    definition:
      'A Rent Plan is in live repayment when status is funded or disbursed. Pre-disbursement stages (pending, tenant_ops_approved, landlord_ops_approved, coo_approved) are pipeline.',
    measurementGotcha:
      'The daily repayment clock starts the day after landlord payout disbursement, not on the application date.',
    sourceNote: 'assistant_staff_rent_pipeline_summary · assistant_staff_tenant_ops_overview',
  },
  {
    termKey: 'agent_vs_sub_agent',
    termTitle: 'Field Agent vs Sub-Agent',
    category: 'operations',
    definition:
      'Field agents onboard tenants and landlords directly; sub-agents are recruited under a parent agent and share a split on registration/commission pools.',
    measurementGotcha:
      'Agent lending uses agents own capital and is excluded from company Receivables.',
    sourceNote: 'assistant_staff_agent_ops_overview · assistant_staff_agent_commission_detail',
  },
  {
    termKey: 'regulatory_terminology',
    termTitle: 'Mandatory Regulatory Terminology',
    category: 'definition',
    definition:
      'Welile facilitates Rent Plans backed by Supporters who earn Returns.',
    measurementGotcha:
      'Never use banned lending terms in staff or external copy; always use Rent Plan, Supporter, and Returns.',
    sourceNote: 'Welile Compliance Policy',
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
  errorMessage?: string | null;
  remainingQuestionsToday?: number | null;
  onSendMessage: (prompt: string) => void | Promise<void>;
  onStopGenerating?: () => void;
  onRegenerate?: () => void | Promise<void>;
  onSelectConversation?: (conversationId: string) => void | Promise<void>;
  onStartNewChat?: () => void | Promise<void>;
  onRenameConversation?: (conversationId: string, title: string) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  onFeedback: (messageId: string, rating: ZoeFeedbackRating) => void | Promise<void>;
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
}

type ConfirmZoeScheduleResult = ConfirmZoeActionResult;

/**
 * Strips a trailing `Source: ... · Period: ...` line from the message body when we
 * already render the structured Source · dates footer underneath the bubble.
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
  errorMessage = null,
  remainingQuestionsToday = null,
  onSendMessage,
  onStopGenerating,
  onRegenerate,
  onSelectConversation,
  onStartNewChat,
  onRenameConversation,
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
}) => {
  const [draft, setDraft] = useState('');
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
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const suggestions: ZoeSuggestion[] = getSuggestionsForRoles(roles);

  const canManageGlossary = roles.some((r) => GLOSSARY_MANAGER_ROLES.has(r.toLowerCase()));
  const activeGlossaryEntries =
    glossaryEntries.length > 0 ? glossaryEntries : DEFAULT_WELILE_GLOSSARY_ENTRIES;

  useEffect(() => {
    if (typeof endOfMessagesRef.current?.scrollIntoView === 'function') {
      endOfMessagesRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, isLoading, streamingText, errorMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!trimmed || isLoading) return;
    setDraft('');
    await onSendMessage(trimmed);
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
      termKey: glossaryTermKey.trim(),
      termTitle: glossaryTermTitle.trim(),
      category: glossaryCategory,
      definition: glossaryDefinition.trim(),
      measurementGotcha: glossaryGotcha.trim(),
      sourceNote: glossarySourceNote.trim(),
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

  return (
    <div
      data-testid="zoe-chat-surface"
      className={cn(
        'flex w-full min-w-0 flex-col rounded-xl border border-border bg-card text-card-foreground shadow-sm',
        compact ? 'h-[min(640px,calc(100vh-6rem))]' : 'min-h-[calc(100vh-11rem)]',
      )}
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <MessageSquare className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground sm:text-base">
              Zoe · My Space Assistant
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              Read-only answers from your official My Space records and department reports
              {typeof remainingQuestionsToday === 'number'
                ? ` · ${remainingQuestionsToday} left today`
                : ''}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {headerSlot}
          <button
            type="button"
            onClick={() => {
              setShowNotesDrawer((prev) => !prev);
              setShowGlossaryDrawer(false);
              setShowConversationList(false);
            }}
            data-testid="zoe-notes-toggle"
            aria-expanded={showNotesDrawer}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bookmark className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Zoe notes ({notes.length})</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setShowGlossaryDrawer((prev) => !prev);
              setShowNotesDrawer(false);
              setShowConversationList(false);
            }}
            data-testid="zoe-glossary-toggle"
            aria-expanded={showGlossaryDrawer}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Glossary</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setShowConversationList((prev) => !prev);
              setShowNotesDrawer(false);
              setShowGlossaryDrawer(false);
            }}
            data-testid="zoe-conversations-toggle"
            aria-expanded={showConversationList}
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <History className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Chats ({conversations.length})</span>
          </button>

          {onStartNewChat && (
            <button
              type="button"
              onClick={() => void onStartNewChat()}
              disabled={isLoading}
              data-testid="zoe-new-chat-button"
              className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>New chat</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => void onClearHistory()}
            disabled={isLoading || (messages.length === 0 && !errorMessage)}
            data-testid="zoe-clear-history"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Clear my history</span>
          </button>
        </div>
      </div>

      {/* Collapsible Zoe Notes Drawer (up to 20 short personal preferences; never business figures or PII) */}
      {showNotesDrawer && (
        <div
          data-testid="zoe-notes-drawer"
          className="border-b border-border bg-muted/30 px-3 py-2.5 sm:px-4 space-y-2.5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
                Your Zoe Notes ({notes.length}/{MAX_ZOE_NOTES})
              </span>
              <p className="text-xs text-muted-foreground">
                Short preferences Zoe remembers across chats (e.g. &ldquo;Show Kampala West first&rdquo;). Never store UGX figures or personal data about others.
              </p>
            </div>
          </div>

          {onAddNote && (
            <form onSubmit={(e) => void handleAddNoteSubmit(e)} className="flex flex-wrap items-center gap-2">
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
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              {noteError}
            </p>
          )}

          {notes.length === 0 ? (
            <p className="py-1 text-xs text-muted-foreground">
              No saved Zoe notes yet.
            </p>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto">
              {notes.map((n) => (
                <div
                  key={n.id}
                  data-testid={`zoe-note-item-${n.id}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground"
                >
                  <span className="min-w-0 flex-1 break-words">{n.noteText}</span>
                  {onDeleteNote && (
                    <button
                      type="button"
                      aria-label={`Delete note ${n.noteText}`}
                      data-testid={`zoe-note-delete-${n.id}`}
                      onClick={() => void onDeleteNote(n.id)}
                      className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg border border-border bg-background px-2 text-xs text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Collapsible Welile Glossary Drawer + Manager Screen (never editable through Zoe chat) */}
      {showGlossaryDrawer && (
        <div
          data-testid="zoe-glossary-drawer"
          className="border-b border-border bg-muted/30 px-3 py-2.5 sm:px-4 space-y-3"
        >
          <div>
            <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
              Welile Glossary & Measurement Gotchas
            </span>
            <p className="text-xs text-muted-foreground">
              Official definitions Zoe uses via get_welile_glossary so figures and terms stay accurate.
            </p>
          </div>

          <div className="max-h-56 space-y-2 overflow-y-auto">
            {activeGlossaryEntries.map((entry) => (
              <div
                key={entry.termKey}
                data-testid={`zoe-glossary-item-${entry.termKey}`}
                className="rounded-lg border border-border bg-background p-2.5 text-xs space-y-1"
              >
                <div className="flex flex-wrap items-center justify-between gap-1.5">
                  <span className="font-semibold text-foreground">{entry.termTitle}</span>
                  <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {entry.category.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="text-foreground leading-relaxed">{entry.definition}</p>
                {entry.measurementGotcha && (
                  <p className="text-muted-foreground leading-relaxed">
                    <span className="font-semibold text-foreground">Measurement gotcha: </span>
                    {entry.measurementGotcha}
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
                  disabled={!glossaryTermKey.trim() || !glossaryTermTitle.trim() || !glossaryDefinition.trim()}
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
      )}

      {/* Collapsible Conversation List Drawer / Bar (titles, rename, new chat) */}
      {showConversationList && (
        <div
          data-testid="zoe-conversation-drawer"
          className="border-b border-border bg-muted/30 px-3 py-2.5 sm:px-4 space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recent Conversations
            </span>
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
          </div>

          {conversations.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              No saved conversations yet. Ask a question below to start.
            </p>
          ) : (
            <div className="max-h-48 space-y-1.5 overflow-y-auto">
              {conversations.map((conv) => {
                const isEditing = editingConvId === conv.id;
                const isActive = activeConversationId === conv.id;
                return (
                  <div
                    key={conv.id}
                    data-testid={`zoe-conv-item-${conv.id}`}
                    className={cn(
                      'flex flex-wrap items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-xs',
                      isActive
                        ? 'border-primary/50 bg-primary/10 text-foreground'
                        : 'border-border bg-background text-foreground',
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
                          data-testid={`zoe-conv-rename-input-${conv.id}`}
                          className="min-h-[44px] min-w-0 flex-1 rounded border border-input bg-background px-2.5 py-1 text-xs text-foreground"
                        />
                        <button
                          type="button"
                          data-testid={`zoe-conv-rename-save-${conv.id}`}
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
                        {onRenameConversation && (
                          <button
                            type="button"
                            aria-label={`Rename ${conv.title || 'chat'}`}
                            data-testid={`zoe-conv-rename-btn-${conv.id}`}
                            onClick={() => {
                              setEditingConvId(conv.id);
                              setRenameDraft(conv.title || '');
                            }}
                            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border border-border bg-background px-2 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Message list & empty state */}
      <div
        className="flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-4"
        role="log"
        aria-live="polite"
        aria-label="Zoe conversation messages"
      >
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

        {!isHistoryLoading && messages.length === 0 && !isLoading && !errorMessage ? (
          <div data-testid="zoe-empty-state" className="space-y-4 py-2">
            <div className="rounded-lg border border-border/80 bg-muted/40 p-3.5 sm:p-4">
              <p className="text-sm font-semibold text-foreground">
                Ask Zoe about your My Space items or department reports
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Zoe reads only the official Welile database functions your role is permitted to access.
                Every answer cites the exact data source and period.
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Suggested questions for your role
              </p>
              <div
                data-testid="zoe-suggestion-list"
                className="flex flex-wrap gap-2"
              >
                {suggestions.map((chip) => (
                  <button
                    key={chip.id}
                    type="button"
                    data-testid={`zoe-suggestion-${chip.id}`}
                    onClick={() => void handleSuggestionClick(chip.prompt)}
                    className="inline-flex min-h-[44px] items-center rounded-lg border border-border bg-background px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {chip.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {/* Conversation turns */}
        {messages.map((msg, msgIdx) => {
          if (msg.role === 'user') {
            return (
              <div
                key={msg.id}
                data-testid="zoe-user-message"
                className="flex justify-end"
              >
                <div className="max-w-[88%] rounded-xl bg-primary px-3.5 py-2.5 text-xs leading-relaxed text-primary-foreground sm:max-w-[75%] sm:text-sm">
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

          return (
            <div
              key={msg.id}
              data-testid="zoe-assistant-message"
              className="flex justify-start"
            >
              <div className="w-full max-w-[96%] space-y-2.5 rounded-xl border border-border bg-muted/30 p-3.5 text-foreground sm:max-w-[85%] sm:p-4">
                <ZoeMarkdown content={bodyText} />

                {/* Mini bar/line chart when the answer is a time series or ranking */}
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

                {/* Collapsible "Show the data" raw table view */}
                {isDataExpanded && rawRows.length > 0 && (
                  <div
                    data-testid={`zoe-raw-data-table-${msg.id}`}
                    className="my-2 max-h-64 overflow-auto rounded-lg border border-border bg-background"
                  >
                    <table className="w-full min-w-[280px] border-collapse text-left text-xs">
                      <thead>
                        <tr className="border-b border-border bg-muted/60">
                          {Object.keys(rawRows[0]).map((col) => (
                            <th
                              key={col}
                              className="px-2.5 py-2 font-semibold text-foreground whitespace-nowrap"
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
                                className="px-2.5 py-1.5 text-xs text-foreground whitespace-nowrap"
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

                {/* 2 or 3 Suggested follow-up questions under each answer */}
                {followUps.length > 0 && (
                  <div
                    data-testid={`zoe-follow-ups-${msg.id}`}
                    className="flex flex-wrap gap-1.5 pt-1"
                  >
                    {followUps.slice(0, 3).map((q) => (
                      <button
                        key={q}
                        type="button"
                        disabled={isLoading}
                        onClick={() => void handleSuggestionClick(q)}
                        className="inline-flex min-h-[44px] items-center rounded-lg border border-border bg-background px-2.5 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}

                {/* Source · dates citation + link to the matching screen */}
                {hasSourceMeta && (
                  <div
                    data-testid="zoe-source-line"
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5 text-xs text-muted-foreground"
                  >
                    <span className="min-w-0 break-words">
                      Source: {sourceLabel ?? 'Official report'}
                      {periodLabel ? ` · ${periodLabel}` : ''}
                    </span>
                    {screenLink && (
                      <Link
                        to={screenLink.to}
                        data-testid="zoe-screen-link"
                        className="inline-flex min-h-[44px] items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-primary underline-offset-4 hover:bg-primary/10 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span>{screenLink.label}</span>
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      </Link>
                    )}
                  </div>
                )}

                {/* Action bar: Copy, Regenerate, Show the data, Thumbs up / down feedback */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`zoe-copy-${msg.id}`}
                      onClick={() => void handleCopyMessage(msg.id, msg.content)}
                      className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {copiedMessageId === msg.id ? (
                        <>
                          <Check className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Copy</span>
                        </>
                      )}
                    </button>

                    {msg.id === lastAssistantId && onRegenerate && (
                      <button
                        type="button"
                        disabled={isLoading}
                        data-testid={`zoe-regenerate-${msg.id}`}
                        onClick={() => void onRegenerate()}
                        className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Regenerate</span>
                      </button>
                    )}

                    {rawRows.length > 0 && (
                      <button
                        type="button"
                        data-testid={`zoe-show-data-${msg.id}`}
                        aria-expanded={isDataExpanded}
                        onClick={() => toggleShowData(msg.id)}
                        className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Database className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{isDataExpanded ? 'Hide the data' : 'Show the data'}</span>
                      </button>
                    )}

                    <span className="ml-1 text-xs text-muted-foreground">Helpful?</span>
                    <button
                      type="button"
                      aria-label="Helpful answer"
                      aria-pressed={msg.feedback === 'up'}
                      data-testid={`zoe-feedback-up-${msg.id}`}
                      onClick={() => void onFeedback(msg.id, 'up')}
                      className={cn(
                        'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        msg.feedback === 'up'
                          ? 'border-primary bg-primary/15 text-primary'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <ThumbsUp className="h-4 w-4" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      aria-label="Not helpful answer"
                      aria-pressed={msg.feedback === 'down'}
                      data-testid={`zoe-feedback-down-${msg.id}`}
                      onClick={() => void onFeedback(msg.id, 'down')}
                      className={cn(
                        'inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        msg.feedback === 'down'
                          ? 'border-destructive bg-destructive/10 text-destructive'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <ThumbsDown className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>

                  {renderMessageAction ? renderMessageAction(msg) : null}
                </div>
              </div>
            </div>
          );
        })}

        {/* Live status line + streaming preview + Stop button */}
        {isLoading && (
          <div
            role="status"
            aria-live="polite"
            data-testid="zoe-typing-indicator"
            className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-border bg-muted/30 px-3.5 py-3 text-xs text-muted-foreground"
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
              <span data-testid="zoe-live-status-line" className="truncate">
                {statusLine || 'Zoe is reading official records...'}
              </span>
            </div>
            {onStopGenerating && (
              <button
                type="button"
                onClick={onStopGenerating}
                data-testid="zoe-stop-button"
                className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Square className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Stop</span>
              </button>
            )}
            {streamingText && (
              <div className="w-full pt-1 text-foreground">
                <ZoeMarkdown content={streamingText} />
              </div>
            )}
          </div>
        )}

        {/* Error banner with Retry */}
        {errorMessage && (
          <div
            role="alert"
            data-testid="zoe-error-banner"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-xs text-destructive"
          >
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="break-words leading-relaxed">{errorMessage}</span>
            </div>
            {onRetry && (
              <button
                type="button"
                data-testid="zoe-retry-button"
                onClick={() => void onRetry()}
                disabled={isLoading}
                className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-lg border border-destructive/40 bg-background px-3 py-2 text-xs font-semibold text-destructive transition-colors hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Retry</span>
              </button>
            )}
          </div>
        )}

        <div ref={endOfMessagesRef} />
      </div>

      {/* Role-based quick suggestion bar when conversation already has turns */}
      {messages.length > 0 && suggestions.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto border-t border-border/60 bg-muted/20 px-3 py-2 sm:px-4">
          {suggestions.slice(0, 4).map((chip) => (
            <button
              key={chip.id}
              type="button"
              disabled={isLoading}
              onClick={() => void handleSuggestionClick(chip.prompt)}
              className="inline-flex min-h-[44px] shrink-0 items-center rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}

      {/* Typing-only composer (2,000-character limit, 44px tap targets) */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex items-end gap-2 border-t border-border bg-background/80 p-3 sm:px-4"
      >
        <label htmlFor="zoe-question-input" className="sr-only">
          Ask Zoe a question
        </label>
        <input
          id="zoe-question-input"
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_MESSAGE_LENGTH}
          disabled={isLoading}
          placeholder="Type a question about your My Space or department reports..."
          data-testid="zoe-input"
          className="min-h-[44px] min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        />
        <button
          type="submit"
          disabled={isLoading || !draft.trim()}
          data-testid="zoe-send-button"
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
        >
          <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Send</span>
        </button>
      </form>
    </div>
  );
};

export default ZoeChatSurface;
