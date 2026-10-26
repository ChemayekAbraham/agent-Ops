import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle,
  ExternalLink,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  ThumbsDown,
  ThumbsUp,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  getSuggestionsForRoles,
  resolveSourceScreenLink,
  type ZoeSuggestion,
} from './zoeConfig';
import type { ZoeFeedbackRating, ZoeMessage } from './useZoeAssistant';

export interface ZoeChatSurfaceProps {
  messages: ZoeMessage[];
  roles?: readonly string[];
  isLoading: boolean;
  isHistoryLoading?: boolean;
  errorMessage?: string | null;
  remainingQuestionsToday?: number | null;
  onSendMessage: (prompt: string) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
  onFeedback: (messageId: string, rating: ZoeFeedbackRating) => void | Promise<void>;
  onClearHistory: () => void | Promise<void>;
  /** Optional extra action slot in the header (e.g., "Open full page" link inside floating drawer, or "Email report" button in step 9). */
  headerSlot?: React.ReactNode;
  /** Optional extra action slot rendered per answered assistant message (e.g., "Email this report" in step 9). */
  renderMessageAction?: (message: ZoeMessage) => React.ReactNode;
  compact?: boolean;
}

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

export const ZoeChatSurface: React.FC<ZoeChatSurfaceProps> = ({
  messages,
  roles = [],
  isLoading,
  isHistoryLoading = false,
  errorMessage = null,
  remainingQuestionsToday = null,
  onSendMessage,
  onRetry,
  onFeedback,
  onClearHistory,
  headerSlot,
  renderMessageAction,
  compact = false,
}) => {
  const [draft, setDraft] = useState('');
  const endOfMessagesRef = useRef<HTMLDivElement | null>(null);
  const suggestions: ZoeSuggestion[] = getSuggestionsForRoles(roles);

  useEffect(() => {
    if (typeof endOfMessagesRef.current?.scrollIntoView === 'function') {
      endOfMessagesRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, isLoading, errorMessage]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || isLoading) return;
    setDraft('');
    await onSendMessage(trimmed);
  };

  const handleSuggestionClick = async (prompt: string) => {
    if (isLoading) return;
    await onSendMessage(prompt);
  };

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

        <div className="flex items-center gap-2">
          {headerSlot}
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

      {/* Message list & empty state */}
      <div
        className="flex-1 space-y-4 overflow-y-auto px-3 py-4 sm:px-4"
        role="log"
        aria-live="polite"
        aria-label="Zoe conversation messages"
      >
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
        {messages.map((msg) => {
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

          const { bodyText, sourceLabel, periodLabel } = parseMessageBodyAndMeta(msg);
          const hasSourceMeta = Boolean(sourceLabel || periodLabel);
          const screenLink = hasSourceMeta ? resolveSourceScreenLink(sourceLabel) : null;

          return (
            <div
              key={msg.id}
              data-testid="zoe-assistant-message"
              className="flex justify-start"
            >
              <div className="w-full max-w-[96%] space-y-2.5 rounded-xl border border-border bg-muted/30 p-3.5 text-foreground sm:max-w-[85%] sm:p-4">
                <p className="whitespace-pre-wrap break-words text-xs leading-relaxed sm:text-sm">
                  {bodyText}
                </p>

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

                {/* Thumbs up / down feedback (saved to staff_assistant_feedback) + optional extra action */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">Was this helpful?</span>
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

        {/* Typing indicator */}
        {isLoading && (
          <div
            role="status"
            aria-live="polite"
            data-testid="zoe-typing-indicator"
            className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/30 px-3.5 py-3 text-xs text-muted-foreground sm:w-fit"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
            <span>Zoe is reading official records...</span>
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

      {/* Typing-only composer (no voice input) */}
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
          maxLength={500}
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
