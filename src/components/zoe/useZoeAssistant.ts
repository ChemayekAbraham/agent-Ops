import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { safeUUID } from '@/lib/safeUUID';
import type { ZoeMorningBriefPayload } from '@/lib/zoe';

export type ZoeTurnOutcome =
  | 'answered'
  | 'clarify'
  | 'out_of_scope'
  | 'not_staff'
  | 'unmatched'
  | 'rate_limited'
  | 'blocked'
  | 'error';

export type ZoeFeedbackRating = 'up' | 'down';

export interface ZoeClarification {
  question: string;
  options: string[];
}

export interface ZoeConversationListItem {
  id: string;
  title: string;
  message_count: number;
  last_active_at: string;
  created_at: string;
}

export interface ZoeNoteItem {
  id: string;
  note_text: string;
  created_at: string;
}

export interface ZoeGlossaryEntry {
  slug: string;
  term: string;
  category: string;
  plain_definition: string;
  measurement_gotcha: string;
  official_source: string;
  screen_path: string;
  keywords?: string[];
  updated_at?: string;
}

export interface ZoeGlossaryUpsertInput {
  slug: string;
  term: string;
  category: string;
  plain_definition: string;
  measurement_gotcha?: string;
  official_source?: string;
  screen_path?: string;
  keywords?: string[];
  is_active?: boolean;
}

export type ZoeKnowledgeCategory =
  | 'glossary'
  | 'product_policy'
  | 'process_explanation'
  | 'where_to_find'
  | 'measurement_gotcha';

export interface ZoeKnowledgeEntry {
  slug: string;
  title: string;
  category: ZoeKnowledgeCategory;
  summary: string;
  body: string;
  measurement_gotcha: string;
  where_to_find: string;
  screen_path: string;
  official_source: string;
  keywords?: string[];
  is_published?: boolean;
  updated_at?: string;
}

export interface ZoeKnowledgeUpsertInput {
  slug: string;
  title: string;
  category: ZoeKnowledgeCategory;
  summary: string;
  body?: string;
  measurement_gotcha?: string;
  where_to_find?: string;
  screen_path?: string;
  official_source?: string;
  keywords?: string[];
  is_published?: boolean;
}

export interface ZoeMemorySuggestion {
  key: string;
  note_text: string;
  prompt: string;
}

export interface ZoePersonalisedStarter {
  id: string;
  label: string;
  prompt: string;
  topic?: string;
  tool?: string;
}

export interface ZoeMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  outcome?: ZoeTurnOutcome | null;
  source?: string | null;
  period?: string | null;
  clarification?: ZoeClarification | null;
  reportPayload?: Record<string, unknown> | null;
  followUpSuggestions?: string[];
  researchMode?: boolean;
  researchPlan?: string[];
  feedback?: ZoeFeedbackRating | null;
  createdAt?: string;
}

interface StaffAssistantEdgeResponse {
  conversation_id?: string | null;
  message_id?: string | null;
  reply?: string;
  error?: string;
  outcome?: ZoeTurnOutcome;
  clarification?: ZoeClarification | null;
  source?: string | null;
  period?: string | null;
  report_payload?: Record<string, unknown> | null;
  follow_up_suggestions?: string[];
  memory_suggestion?: ZoeMemorySuggestion | null;
  temporary_chat?: boolean;
  memory_enabled?: boolean;
  status_steps?: string[];
  research_mode?: boolean;
  research_plan?: string[];
  mfa_required?: boolean;
  remaining_questions_today?: number;
  conversations?: ZoeConversationListItem[];
  conversation?: ZoeConversationListItem;
  title?: string;
  messages?: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    outcome: ZoeTurnOutcome | null;
    source_label: string | null;
    period_label: string | null;
    report_payload: Record<string, unknown> | null;
    created_at: string;
  }>;
}

/**
 * Replaces a single paragraph at `paragraphIndex` (split on `\n\n+`) in `streamedText`
 * when the server-side per-paragraph figure check (`checkStreamedParagraph`) emits
 * `event: paragraph_replace` with `"I could not verify that figure"`.
 */
export function applyStreamParagraphReplacement(
  streamedText: string,
  paragraphIndex: number,
  replacement = 'I could not verify that figure',
): string {
  const parts = (streamedText ?? '').split(/\n\n+/);
  if (paragraphIndex < 0 || paragraphIndex >= parts.length) {
    return streamedText;
  }
  parts[paragraphIndex] = replacement;
  return parts.join('\n\n');
}

/**
 * Parses an SSE stream body (`event: status`, `event: plan`, `event: token`,
 * `event: paragraph_replace`, `event: done`) emitted by `staff-assistant` when `stream: true`.
 */
export function parseSseEventsFromChunk(
  rawBuffer: string,
  callbacks: {
    onStatus?: (step: string) => void;
    onPlan?: (steps: string[]) => void;
    onToken?: (token: string) => void;
    onParagraphReplace?: (index: number, replacement: string) => void;
    onDone?: (payload: StaffAssistantEdgeResponse) => void;
  },
): string {
  const frames = rawBuffer.split('\n\n');
  const remainder = frames.pop() ?? '';

  for (const frame of frames) {
    const lines = frame.split('\n');
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;
      if (eventName === 'status' && typeof parsed.step === 'string') {
        callbacks.onStatus?.(parsed.step);
      } else if (eventName === 'plan' && Array.isArray(parsed.steps)) {
        callbacks.onPlan?.(parsed.steps.filter((s): s is string => typeof s === 'string'));
      } else if (eventName === 'token' && typeof parsed.token === 'string') {
        callbacks.onToken?.(parsed.token);
      } else if (eventName === 'paragraph_replace' && typeof parsed.index === 'number') {
        callbacks.onParagraphReplace?.(
          parsed.index,
          typeof parsed.replacement === 'string'
            ? parsed.replacement
            : 'I could not verify that figure',
        );
      } else if (eventName === 'done') {
        callbacks.onDone?.(parsed as unknown as StaffAssistantEdgeResponse);
      }
    } catch {
      /* ignore malformed frame */
    }
  }

  return remainder;
}

const FALLBACK_ERROR = "I'm having trouble reading that report right now. Please try again in a moment.";
export const MAX_MESSAGE_LENGTH = 2000;

function collectDevice() {
  if (typeof navigator === 'undefined') return undefined;
  let timezone: string | undefined;
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* ignore */
  }
  return {
    platform: navigator.platform?.slice(0, 40) || undefined,
    language: navigator.language?.slice(0, 20) || undefined,
    timezone: timezone?.slice(0, 60),
    screen_w: typeof screen !== 'undefined' ? Math.round(screen.width) : undefined,
    screen_h: typeof screen !== 'undefined' ? Math.round(screen.height) : undefined,
    pixel_ratio: typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 10) : undefined,
    touch: typeof navigator.maxTouchPoints === 'number' ? navigator.maxTouchPoints > 0 : undefined,
  };
}

async function readEdgeResponse(data: unknown, error: unknown): Promise<StaffAssistantEdgeResponse> {
  if (!error) return (data ?? {}) as StaffAssistantEdgeResponse;
  const ctx = (error as { context?: unknown }).context;
  if (ctx instanceof Response) {
    try {
      return (await ctx.clone().json()) as StaffAssistantEdgeResponse;
    } catch {
      /* fall through */
    }
  }
  return { reply: FALLBACK_ERROR, error: FALLBACK_ERROR, outcome: 'error' };
}

/**
 * Checks whether the current signed-in user passes `public.staff_assistant_has_access()`.
 */
export function useZoeAccess() {
  const { user } = useAuth();
  return useQuery<boolean>({
    queryKey: ['staff-assistant-has-access', user?.id ?? null],
    enabled: Boolean(user?.id),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!user?.id) return false;
      const { data, error } = await supabase.rpc('staff_assistant_has_access' as never);
      if (error) return false;
      return data === true;
    },
  });
}

export interface UseZoeAssistantReturn {
  messages: ZoeMessage[];
  conversations: ZoeConversationListItem[];
  activeConversationId: string | null;
  morningBrief: ZoeMorningBriefPayload | null;
  notes: ZoeNoteItem[];
  glossaryEntries: ZoeGlossaryEntry[];
  knowledgeEntries: ZoeKnowledgeEntry[];
  personalisedStarters: ZoePersonalisedStarter[];
  memoryEnabled: boolean;
  temporaryChat: boolean;
  memorySuggestion: ZoeMemorySuggestion | null;
  isLoading: boolean;
  isHistoryLoading: boolean;
  streamingText: string | null;
  statusLine: string | null;
  researchMode: boolean;
  researchPlanSteps: string[];
  errorMessage: string | null;
  lastFailedPrompt: string | null;
  remainingQuestionsToday: number | null;
  setResearchMode: (enabled: boolean | ((prev: boolean) => boolean)) => void;
  setMemoryEnabled: (enabled: boolean) => Promise<void>;
  setTemporaryChat: (enabled: boolean) => void;
  acceptMemorySuggestion: () => Promise<{ ok: boolean; error?: string }>;
  dismissMemorySuggestion: () => Promise<void>;
  sendMessage: (prompt: string) => Promise<void>;
  stopGenerating: () => void;
  regenerateLastAnswer: () => Promise<void>;
  retryLastMessage: () => Promise<void>;
  submitFeedback: (
    messageId: string,
    rating: ZoeFeedbackRating,
    options?: { comment?: string; reportKind?: 'rating' | 'problem_report' },
  ) => Promise<void>;
  clearHistory: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  startNewChat: () => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  addNote: (noteText: string) => Promise<{ ok: boolean; error?: string }>;
  updateNote: (noteId: string, noteText: string) => Promise<{ ok: boolean; error?: string }>;
  deleteNote: (noteId: string) => Promise<{ ok: boolean }>;
  saveGlossaryEntry: (input: ZoeGlossaryUpsertInput) => Promise<{ ok: boolean; error?: string }>;
  saveKnowledgeEntry: (input: ZoeKnowledgeUpsertInput) => Promise<{ ok: boolean; error?: string }>;
}

export function useZoeAssistant(enabled = true): UseZoeAssistantReturn {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ZoeMessage[]>([]);
  const [conversations, setConversations] = useState<ZoeConversationListItem[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [morningBrief, setMorningBrief] = useState<ZoeMorningBriefPayload | null>(null);
  const [notes, setNotes] = useState<ZoeNoteItem[]>([]);
  const [glossaryEntries, setGlossaryEntries] = useState<ZoeGlossaryEntry[]>([]);
  const [knowledgeEntries, setKnowledgeEntries] = useState<ZoeKnowledgeEntry[]>([]);
  const [personalisedStarters, setPersonalisedStarters] = useState<ZoePersonalisedStarter[]>([]);
  const [memoryEnabled, setMemoryEnabledState] = useState<boolean>(true);
  const [temporaryChat, setTemporaryChatState] = useState<boolean>(false);
  const [memorySuggestion, setMemorySuggestion] = useState<ZoeMemorySuggestion | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [streamingText, setStreamingText] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [researchMode, setResearchMode] = useState<boolean>(false);
  const [researchPlanSteps, setResearchPlanSteps] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastFailedPrompt, setLastFailedPrompt] = useState<string | null>(null);
  const [remainingQuestionsToday, setRemainingQuestionsToday] = useState<number | null>(null);

  const conversationIdRef = useRef<string | undefined>(undefined);
  const inFlightRef = useRef(false);
  const generationRef = useRef(0);
  const streamTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);


  const clearStreamTimer = useCallback(() => {
    if (streamTimerRef.current) {
      clearInterval(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  }, []);

  // Load recent server-owned conversation history and conversation list when mounted or when user changes
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    clearStreamTimer();
    inFlightRef.current = false;
    conversationIdRef.current = undefined;
    setActiveConversationId(null);
    setMessages([]);
    setConversations([]);
    setIsLoading(false);
    setStreamingText(null);
    setStatusLine(null);
    setErrorMessage(null);
    setLastFailedPrompt(null);

    if (!user?.id || !enabled) {
      setIsHistoryLoading(false);
      return;
    }

    let cancelled = false;
    setIsHistoryLoading(true);
    setMorningBrief(null);
    supabase.functions
      .invoke('staff-assistant', { body: { action: 'history', limit: 40 } })
      .then(async ({ data, error }) => {
        if (cancelled || generation !== generationRef.current) return;
        const res = await readEdgeResponse(data, error);
        if (res.conversation_id) {
          conversationIdRef.current = res.conversation_id;
          setActiveConversationId(res.conversation_id);
        }
        if (Array.isArray(res.messages) && res.messages.length > 0) {
          setMessages(
            res.messages.map((m) => {
              const rp = m.report_payload ?? null;
              const followUps =
                rp && Array.isArray(rp.follow_up_suggestions)
                  ? (rp.follow_up_suggestions as string[])
                  : undefined;
              return {
                id: m.id,
                role: m.role,
                content: m.content,
                outcome: m.outcome ?? null,
                source: m.source_label ?? null,
                period: m.period_label ?? null,
                reportPayload: rp,
                followUpSuggestions: followUps,
                createdAt: m.created_at,
              };
            }),
          );
        }
      })
      .catch(() => {
        /* ignore history load error on initial open */
      })
      .finally(() => {
        if (!cancelled && generation === generationRef.current) {
          setIsHistoryLoading(false);
        }
      });

    // Load conversation list
    supabase.functions
      .invoke('staff-assistant', { body: { action: 'conversations', limit: 25 } })
      .then(async ({ data, error }) => {
        if (cancelled || generation !== generationRef.current) return;
        const res = await readEdgeResponse(data, error);
        if (Array.isArray(res.conversations)) {
          setConversations(res.conversations);
        }
      })
      .catch(() => {
        /* ignore */
      });

    // Load optional 07:30 Kampala Morning Brief
    supabase.functions
      .invoke<{ morning_brief?: ZoeMorningBriefPayload }>('staff-assistant', {
        body: { action: 'morning_brief', force: false },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (data?.morning_brief) {
          setMorningBrief(data.morning_brief);
        }
      })
      .catch(() => {
        /* ignore brief load error */
      });

    // Load per-person Zoe notes (up to 20 short preferences)
    supabase.functions
      .invoke<{ notes?: ZoeNoteItem[] }>('staff-assistant', {
        body: { action: 'list_notes' },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (Array.isArray(data?.notes)) {
          setNotes(data.notes);
        }
      })
      .catch(() => {
        /* ignore notes load error */
      });

    // Load Welile glossary entries
    supabase.functions
      .invoke<{ rows?: ZoeGlossaryEntry[] }>('staff-assistant', {
        body: { action: 'list_glossary' },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (Array.isArray(data?.rows)) {
          setGlossaryEntries(data.rows);
        }
      })
      .catch(() => {
        /* ignore glossary load error */
      });

    // Load personalised starters (up to 3 from caller's own last 30 days of topics, role & tools)
    supabase.functions
      .invoke<{ starters?: ZoePersonalisedStarter[] }>('staff-assistant', {
        body: { action: 'personalised_starters' },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (Array.isArray(data?.starters)) {
          setPersonalisedStarters(data.starters.slice(0, 3));
        }
      })
      .catch(() => {
        /* ignore starter load error */
      });

    // Load caller's memory preferences ("Memory off" switch & dismissed suggestions)
    supabase.functions
      .invoke<{ memory_enabled?: boolean }>('staff-assistant', {
        body: { action: 'get_memory_prefs' },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (typeof data?.memory_enabled === 'boolean') {
          setMemoryEnabledState(data.memory_enabled);
        }
      })
      .catch(() => {
        /* ignore memory prefs load error */
      });

    // Load curated Knowledge Base entries
    supabase.functions
      .invoke<{ rows?: ZoeKnowledgeEntry[] }>('staff-assistant', {
        body: { action: 'search_knowledge_base', query: '', limit: 25 },
      })
      .then(({ data }) => {
        if (cancelled || generation !== generationRef.current) return;
        if (Array.isArray(data?.rows)) {
          setKnowledgeEntries(data.rows);
        }
      })
      .catch(() => {
        /* ignore knowledge base load error */
      });

    return () => {
      cancelled = true;
      clearStreamTimer();
    };
  }, [user?.id, enabled, clearStreamTimer]);

  const stopGenerating = useCallback(() => {
    generationRef.current += 1;
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    clearStreamTimer();
    inFlightRef.current = false;
    setIsLoading(false);
    setStreamingText(null);
    setStatusLine(null);
  }, [clearStreamTimer]);

  const setMemoryEnabled = useCallback(
    async (nextEnabled: boolean) => {
      setMemoryEnabledState(nextEnabled);
      if (!nextEnabled) {
        setMemorySuggestion(null);
      }
      if (!user?.id) return;
      try {
        await supabase.functions.invoke('staff-assistant', {
          body: {
            action: 'set_memory_prefs',
            memory_enabled: nextEnabled,
          },
        });
      } catch {
        /* non-blocking */
      }
    },
    [user?.id],
  );

  const setTemporaryChat = useCallback((nextTemp: boolean) => {
    setTemporaryChatState(nextTemp);
    if (nextTemp) {
      setMemorySuggestion(null);
    }
  }, []);

  const sendMessage = useCallback(
    async (rawText: string) => {
      const prompt = rawText.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!prompt || inFlightRef.current || !user?.id) return;

      clearStreamTimer();
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      inFlightRef.current = true;
      setIsLoading(true);
      setStreamingText(null);
      if (researchMode) {
        setResearchPlanSteps([
          `Step 1: Clarify scope and definitions for "${prompt.slice(0, 60)}"`,
          'Step 2: Gather certified Welile figures from official tools',
          'Step 3: Search and read outside sources with links and dates',
          'Step 4: Synthesize cited report with separate Welile vs Outside sections',
        ]);
        setStatusLine('Planning research steps...');
      } else {
        setResearchPlanSteps([]);
        setStatusLine(
          /compare|difference|vs|last week|last month/i.test(prompt)
            ? 'Comparing periods...'
            : 'Looking up official records...',
        );
      }
      setErrorMessage(null);
      setLastFailedPrompt(null);

      const userTurnId = safeUUID();
      setMessages((prev) => [
        ...prev,
        { id: userTurnId, role: 'user', content: prompt, researchMode },
      ]);
      const generation = generationRef.current;

      try {
        const { data, error } = await supabase.functions
          .invoke('staff-assistant', {
            body: {
              action: 'message',
              message: prompt,
              ...(researchMode ? { research_mode: true } : {}),
              ...(temporaryChat ? { temporary_chat: true } : {}),
              memory_enabled: memoryEnabled && !temporaryChat,
              ...(!temporaryChat && conversationIdRef.current
                ? { conversation_id: conversationIdRef.current }
                : {}),
              client_context: { device: collectDevice() },
            },
          })
          .catch(() => ({ data: null, error: new Error(FALLBACK_ERROR) }));

        if (generation !== generationRef.current || abortController.signal.aborted) return;

        let res: StaffAssistantEdgeResponse;
        if (typeof data === 'string' && data.includes('event:')) {
          let donePayload: StaffAssistantEdgeResponse = {};
          let liveAccumulated = '';
          parseSseEventsFromChunk(`${data}\n\n`, {
            onStatus: (step) => setStatusLine(step),
            onPlan: (steps) => setResearchPlanSteps(steps),
            onToken: (token) => {
              liveAccumulated += token;
              setStreamingText(liveAccumulated);
            },
            onParagraphReplace: (idx, replacement) => {
              liveAccumulated = applyStreamParagraphReplacement(
                liveAccumulated,
                idx,
                replacement,
              );
              setStreamingText(liveAccumulated);
            },
            onDone: (payload) => {
              donePayload = payload;
            },
          });
          res = donePayload;
        } else {
          res = await readEdgeResponse(data, error);
        }

        if (Array.isArray(res.research_plan) && res.research_plan.length > 0) {
          setResearchPlanSteps(res.research_plan);
        }

        if (res.memory_suggestion && memoryEnabled && !temporaryChat) {
          setMemorySuggestion(res.memory_suggestion);
        }

        if (res.conversation_id && !temporaryChat) {
          conversationIdRef.current = res.conversation_id;
          setActiveConversationId(res.conversation_id);
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === res.conversation_id);
            const nowIso = new Date().toISOString();
            if (exists) {
              return prev.map((c) =>
                c.id === res.conversation_id
                  ? { ...c, last_active_at: nowIso, message_count: c.message_count + 2 }
                  : c,
              );
            }
            return [
              {
                id: res.conversation_id!,
                title: prompt.slice(0, 80),
                message_count: 2,
                last_active_at: nowIso,
                created_at: nowIso,
              },
              ...prev,
            ];
          });
        }
        if (typeof res.remaining_questions_today === 'number') {
          setRemainingQuestionsToday(res.remaining_questions_today);
        }

        if (Array.isArray(res.status_steps) && res.status_steps.length > 0) {
          setStatusLine(res.status_steps[res.status_steps.length - 1]);
        }

        const outcome = res.outcome ?? (error ? 'error' : 'answered');
        const replyText = res.reply ?? res.error ?? FALLBACK_ERROR;

        if (outcome === 'error' || (error && !res.reply)) {
          setErrorMessage(replyText);
          setLastFailedPrompt(prompt);
          return;
        }

        const followUps = Array.isArray(res.follow_up_suggestions)
          ? res.follow_up_suggestions
          : Array.isArray(res.report_payload?.follow_up_suggestions)
          ? (res.report_payload?.follow_up_suggestions as string[])
          : undefined;

        setMessages((prev) => [
          ...prev,
          {
            id: res.message_id || safeUUID(),
            role: 'assistant',
            content: replyText,
            outcome,
            source: res.source ?? null,
            period: res.period ?? null,
            clarification: res.clarification ?? null,
            reportPayload: res.report_payload ?? null,
            followUpSuggestions: followUps,
            researchMode: res.research_mode === true || researchMode,
            researchPlan: Array.isArray(res.research_plan) ? res.research_plan : undefined,
          },
        ]);
      } catch {
        if (generation === generationRef.current && !abortController.signal.aborted) {
          setErrorMessage(FALLBACK_ERROR);
          setLastFailedPrompt(prompt);
        }
      } finally {
        if (generation === generationRef.current) {
          abortControllerRef.current = null;
          inFlightRef.current = false;
          setIsLoading(false);
          setStreamingText(null);
          setStatusLine(null);
        }
      }
    },
    [user?.id, clearStreamTimer, researchMode, temporaryChat, memoryEnabled],
  );

  const regenerateLastAnswer = useCallback(async () => {
    if (inFlightRef.current) return;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    setMessages((prev) => {
      if (prev.length >= 2 && prev[prev.length - 1].role === 'assistant') {
        return prev.slice(0, -2);
      }
      return prev;
    });
    await sendMessage(lastUserMsg.content);
  }, [messages, sendMessage]);

  const retryLastMessage = useCallback(async () => {
    if (!lastFailedPrompt || inFlightRef.current) return;
    const promptToRetry = lastFailedPrompt;
    setMessages((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].role === 'user' && prev[prev.length - 1].content === promptToRetry) {
        return prev.slice(0, -1);
      }
      return prev;
    });
    await sendMessage(promptToRetry);
  }, [lastFailedPrompt, sendMessage]);

  const submitFeedback = useCallback(
    async (
      messageId: string,
      rating: ZoeFeedbackRating,
      options?: { comment?: string; reportKind?: 'rating' | 'problem_report' },
    ) => {
      if (!user?.id) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, feedback: rating } : m)),
      );

      const convId = conversationIdRef.current;
      if (!convId) return;

      await supabase.functions
        .invoke('staff-assistant', {
          body: {
            action: 'feedback',
            conversation_id: convId,
            message_id: messageId,
            rating,
            ...(options?.reportKind ? { report_kind: options.reportKind } : {}),
            ...(options?.comment?.trim() ? { comment: options.comment.trim() } : {}),
          },
        })
        .catch(() => {
          /* non-blocking */
        });
    },
    [user?.id],
  );

  const selectConversation = useCallback(
    async (conversationId: string) => {
      if (!user?.id || inFlightRef.current) return;
      conversationIdRef.current = conversationId;
      setActiveConversationId(conversationId);
      setIsHistoryLoading(true);
      setErrorMessage(null);
      try {
        const { data, error } = await supabase.functions.invoke('staff-assistant', {
          body: { action: 'history', conversation_id: conversationId, limit: 40 },
        });
        const res = await readEdgeResponse(data, error);
        if (Array.isArray(res.messages)) {
          setMessages(
            res.messages.map((m) => {
              const rp = m.report_payload ?? null;
              const followUps =
                rp && Array.isArray(rp.follow_up_suggestions)
                  ? (rp.follow_up_suggestions as string[])
                  : undefined;
              return {
                id: m.id,
                role: m.role,
                content: m.content,
                outcome: m.outcome ?? null,
                source: m.source_label ?? null,
                period: m.period_label ?? null,
                reportPayload: rp,
                followUpSuggestions: followUps,
                createdAt: m.created_at,
              };
            }),
          );
        } else {
          setMessages([]);
        }
      } catch {
        setMessages([]);
      } finally {
        setIsHistoryLoading(false);
      }
    },
    [user?.id],
  );

  const startNewChat = useCallback(async () => {
    stopGenerating();
    conversationIdRef.current = undefined;
    setActiveConversationId(null);
    setMessages([]);
    setErrorMessage(null);
    setLastFailedPrompt(null);

    if (!user?.id) return;
    try {
      const { data, error } = await supabase.functions.invoke('staff-assistant', {
        body: { action: 'new_conversation', title: 'New chat' },
      });
      const res = await readEdgeResponse(data, error);
      if (res.conversation?.id) {
        conversationIdRef.current = res.conversation.id;
        setActiveConversationId(res.conversation.id);
        setConversations((prev) => [res.conversation!, ...prev.filter((c) => c.id !== res.conversation!.id)]);
      }
    } catch {
      /* ignore */
    }
  }, [user?.id, stopGenerating]);

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      const clean = title.trim().slice(0, 120);
      if (!clean || !user?.id) return;
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title: clean } : c)),
      );
      await supabase.functions
        .invoke('staff-assistant', {
          body: {
            action: 'rename_conversation',
            conversation_id: conversationId,
            title: clean,
          },
        })
        .catch(() => {
          /* ignore */
        });
    },
    [user?.id],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      if (!conversationId) return;
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (conversationIdRef.current === conversationId) {
        generationRef.current += 1;
        clearStreamTimer();
        inFlightRef.current = false;
        conversationIdRef.current = undefined;
        setActiveConversationId(null);
        setMessages([]);
        setIsLoading(false);
        setStreamingText(null);
        setStatusLine(null);
        setErrorMessage(null);
        setLastFailedPrompt(null);
      }
      if (!user?.id) return;
      await supabase.functions
        .invoke('staff-assistant', {
          body: {
            action: 'clear_history',
            conversation_id: conversationId,
          },
        })
        .catch(() => {
          /* ignore */
        });
    },
    [user?.id, clearStreamTimer],
  );

  const clearHistory = useCallback(async () => {
    const convId = conversationIdRef.current;
    generationRef.current += 1;
    clearStreamTimer();
    inFlightRef.current = false;
    conversationIdRef.current = undefined;
    setActiveConversationId(null);
    setMessages([]);
    setIsLoading(false);
    setStreamingText(null);
    setStatusLine(null);
    setErrorMessage(null);
    setLastFailedPrompt(null);

    if (!user?.id) return;
    await supabase.functions
      .invoke('staff-assistant', {
        body: {
          action: 'clear_history',
          ...(convId ? { conversation_id: convId } : {}),
        },
      })
      .catch(() => {
        /* ignore */
      });
  }, [user?.id, clearStreamTimer]);

  const addNote = useCallback(
    async (noteText: string): Promise<{ ok: boolean; error?: string }> => {
      const cleaned = noteText.trim();
      if (!cleaned || !user?.id) {
        return { ok: false, error: 'Please enter a short preference note (2–240 characters).' };
      }
      try {
        const { data, error } = await supabase.functions.invoke<{
          ok?: boolean;
          error?: string;
          notes?: ZoeNoteItem[];
        }>('staff-assistant', {
          body: { action: 'add_note', note_text: cleaned },
        });
        const res = await readEdgeResponse(data, error);
        if (Array.isArray((data as { notes?: ZoeNoteItem[] } | null)?.notes)) {
          setNotes((data as { notes: ZoeNoteItem[] }).notes);
        }
        if ((data as { ok?: boolean } | null)?.ok === false || error) {
          return {
            ok: false,
            error:
              res.error ||
              'Zoe notes may only store short preferences and must never contain business figures or personal data.',
          };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not save Zoe note right now.' };
      }
    },
    [user?.id],
  );

  const updateNote = useCallback(
    async (noteId: string, noteText: string): Promise<{ ok: boolean; error?: string }> => {
      const cleaned = noteText.trim();
      if (!noteId || !cleaned || !user?.id) {
        return { ok: false, error: 'Please enter a short preference note (2–240 characters).' };
      }
      try {
        const { data, error } = await supabase.functions.invoke<{
          ok?: boolean;
          error?: string;
          notes?: ZoeNoteItem[];
        }>('staff-assistant', {
          body: { action: 'update_note', note_id: noteId, note_text: cleaned },
        });
        const res = await readEdgeResponse(data, error);
        if (Array.isArray((data as { notes?: ZoeNoteItem[] } | null)?.notes)) {
          setNotes((data as { notes: ZoeNoteItem[] }).notes);
        }
        if ((data as { ok?: boolean } | null)?.ok === false || error) {
          return {
            ok: false,
            error:
              res.error ||
              'Zoe notes may only store short preferences and must never contain business figures or personal data.',
          };
        }
        return { ok: true };
      } catch {
        return { ok: false, error: 'Could not update Zoe note right now.' };
      }
    },
    [user?.id],
  );

  const acceptMemorySuggestion = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!memorySuggestion) return { ok: false, error: 'No memory suggestion active.' };
    const textToSave = memorySuggestion.note_text;
    setMemorySuggestion(null);
    return addNote(textToSave);
  }, [memorySuggestion, addNote]);

  const dismissMemorySuggestion = useCallback(async () => {
    const key = memorySuggestion?.key;
    setMemorySuggestion(null);
    if (!key || !user?.id) return;
    try {
      await supabase.functions.invoke('staff-assistant', {
        body: {
          action: 'set_memory_prefs',
          memory_enabled: memoryEnabled,
          dismiss_preference_key: key,
        },
      });
    } catch {
      /* non-blocking */
    }
  }, [memorySuggestion, user?.id, memoryEnabled]);

  const deleteNote = useCallback(
    async (noteId: string): Promise<{ ok: boolean }> => {
      if (!noteId || !user?.id) return { ok: false };
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
      try {
        const { data } = await supabase.functions.invoke<{
          ok?: boolean;
          notes?: ZoeNoteItem[];
        }>('staff-assistant', {
          body: { action: 'delete_note', note_id: noteId },
        });
        if (Array.isArray(data?.notes)) {
          setNotes(data.notes);
        }
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
    [user?.id],
  );

  const saveGlossaryEntry = useCallback(
    async (input: ZoeGlossaryUpsertInput): Promise<{ ok: boolean; error?: string }> => {
      if (!user?.id) return { ok: false, error: 'Not signed in.' };
      try {
        const { data, error } = await supabase.rpc(
          'zoe_glossary_upsert_entry' as never,
          {
            p_slug: input.slug,
            p_term: input.term,
            p_category: input.category,
            p_plain_definition: input.plain_definition,
            p_measurement_gotcha: input.measurement_gotcha ?? '',
            p_official_source: input.official_source ?? '',
            p_screen_path: input.screen_path ?? '/me',
            p_keywords: input.keywords ?? [],
            p_is_active: input.is_active ?? true,
          } as never,
        );
        if (error) {
          return { ok: false, error: error.message };
        }
        const entry = (data as { entry?: ZoeGlossaryEntry } | null)?.entry;
        if (entry) {
          setGlossaryEntries((prev) => {
            const idx = prev.findIndex((e) => e.slug === entry.slug);
            if (idx >= 0) {
              const next = [...prev];
              next[idx] = entry;
              return next;
            }
            return [...prev, entry];
          });
        }
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Could not save glossary entry.',
        };
      }
    },
    [user?.id],
  );

  const saveKnowledgeEntry = useCallback(
    async (input: ZoeKnowledgeUpsertInput): Promise<{ ok: boolean; error?: string }> => {
      if (!user?.id) return { ok: false, error: 'Not signed in.' };
      try {
        const { data, error } = await supabase.rpc(
          'staff_assistant_upsert_knowledge_entry' as never,
          {
            p_slug: input.slug,
            p_title: input.title,
            p_category: input.category,
            p_summary: input.summary,
            p_body: input.body || input.where_to_find || input.summary,
            p_measurement_gotcha: input.measurement_gotcha ?? '',
            p_official_source: input.official_source ?? 'SYSTEM_CONTEXT.md',
            p_screen_path: input.screen_path ?? '/me',
            p_keywords: input.keywords ?? [],
            p_review_status: input.is_published === false ? 'draft' : 'published',
          } as never,
        );
        if (error) {
          return { ok: false, error: error.message };
        }
        const raw = (data ?? {}) as { ok?: boolean; error?: string; slug?: string };
        if (raw.ok === false) {
          return { ok: false, error: raw.error || 'Could not save knowledge base entry.' };
        }
        const nextEntry: ZoeKnowledgeEntry = {
          slug: raw.slug || input.slug,
          title: input.title,
          category: input.category,
          summary: input.summary,
          body: input.body ?? '',
          measurement_gotcha: input.measurement_gotcha ?? '',
          where_to_find: input.where_to_find ?? '',
          screen_path: input.screen_path ?? '/me',
          official_source: input.official_source ?? 'SYSTEM_CONTEXT.md',
          keywords: input.keywords ?? [],
          is_published: input.is_published ?? true,
        };
        setKnowledgeEntries((prev) => {
          const idx = prev.findIndex((e) => e.slug === nextEntry.slug);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = nextEntry;
            return next;
          }
          return [nextEntry, ...prev];
        });
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Could not save knowledge base entry.',
        };
      }
    },
    [user?.id],
  );

  return {
    messages,
    conversations,
    activeConversationId,
    morningBrief,
    notes,
    glossaryEntries,
    knowledgeEntries,
    personalisedStarters,
    memoryEnabled,
    temporaryChat,
    memorySuggestion,
    isLoading,
    isHistoryLoading,
    streamingText,
    statusLine,
    researchMode,
    researchPlanSteps,
    errorMessage,
    lastFailedPrompt,
    remainingQuestionsToday,
    setResearchMode,
    setMemoryEnabled,
    setTemporaryChat,
    acceptMemorySuggestion,
    dismissMemorySuggestion,
    sendMessage,
    stopGenerating,
    regenerateLastAnswer,
    retryLastMessage,
    submitFeedback,
    clearHistory,
    selectConversation,
    startNewChat,
    renameConversation,
    deleteConversation,
    addNote,
    updateNote,
    deleteNote,
    saveGlossaryEntry,
    saveKnowledgeEntry,
  };
}

