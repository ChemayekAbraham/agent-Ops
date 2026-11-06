import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ExternalLink, X } from 'lucide-react';
import zoeAvatar from '@/assets/zoe-avatar.svg';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import {
  type OpenZoeWithContextDetail,
  ZOE_OPEN_WITH_PAGE_CONTEXT_EVENT,
} from './AskZoeAboutScreenButton';
import { ZoeChatSurface } from './ZoeChatSurface';
import { useZoeAccess, useZoeAssistant } from './useZoeAssistant';
import { derivePageContextFromLocation } from './zoeConfig';

export const GREETING_MS = 20_000;
export const GREETING_FADE_MS = 600;

/**
 * Module-scoped flag so Zoe's greeting bubble appears at most once per browser
 * page load and is never re-shown when navigating between workspace routes.
 */
let hasGreetedThisPageLoad = false;

export function resetZoeGreetingForTest(): void {
  hasGreetedThisPageLoad = false;
}

export function deriveFirstNameForGreeting(
  fullName?: string | null,
  email?: string | null,
): string {
  const raw = (fullName ?? '').trim() || (email ?? '').split('@')[0]?.trim() || '';
  const firstToken = raw.split(/[\s._-]+/)[0]?.replace(/[^a-zA-Z'-]/g, '') ?? '';
  if (!firstToken) return '';
  return firstToken.charAt(0).toUpperCase() + firstToken.slice(1);
}

export function formatZoeGreetingMessage(firstName?: string | null): string {
  const clean = (firstName ?? '').trim();
  return clean
    ? `Hi ${clean}, need a hand with a report or question?`
    : 'Hi, need a hand with a report or question?';
}

/**
 * Floating "Ask Zoe" launcher displayed on My Space pages when
 * `staff_assistant_has_access()` is true. Mirrors Clara's launcher presence
 * (`src/components/agent/AgentAssistant.tsx`) with Zoe's distinct avatar and a
 * once-per-visit first-name greeting bubble that fades on its own and is
 * suppressed while the chat sheet is open.
 */
export const ZoeFloatingLauncher: React.FC = () => {
  const location = useLocation();
  const { user, roles } = useAuth();
  const { data: hasAccess } = useZoeAccess();
  const [open, setOpen] = useState(false);
  const [showGreeting, setShowGreeting] = useState(false);
  const [fadingGreeting, setFadingGreeting] = useState(false);
  const greetedRef = useRef(hasGreetedThisPageLoad);

  const fullNameMeta =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()) ||
    (typeof user?.user_metadata?.name === 'string' && user.user_metadata.name.trim()) ||
    null;
  const generatedBy = fullNameMeta || user?.email || null;
  const firstName = deriveFirstNameForGreeting(fullNameMeta, user?.email);
  const greetingText = formatZoeGreetingMessage(firstName);

  // Only load conversation history when the floating sheet is actually opened
  const assistant = useZoeAssistant(open && hasAccess === true);

  // Greet once per page load (never re-shown on a route change) and fade on its own,
  // matching Clara's pattern in src/components/agent/AgentAssistant.tsx.
  useEffect(() => {
    if (hasAccess !== true || location.pathname === '/me/zoe') return;
    if (open) {
      setShowGreeting(false);
      return;
    }
    if (greetedRef.current || hasGreetedThisPageLoad) return;
    greetedRef.current = true;
    hasGreetedThisPageLoad = true;
    setShowGreeting(true);
    setFadingGreeting(false);
    const fadeTimer = window.setTimeout(
      () => setFadingGreeting(true),
      GREETING_MS - GREETING_FADE_MS,
    );
    const hideTimer = window.setTimeout(() => setShowGreeting(false), GREETING_MS);
    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(hideTimer);
    };
  }, [hasAccess, location.pathname, open]);

  // Part C item (4): Pass only route name, visible filters, and period (never screen data)
  useEffect(() => {
    if (!open) return;
    assistant.setPageContext(derivePageContextFromLocation(location.pathname, location.search));
  }, [open, location.pathname, location.search]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const custom = ev as CustomEvent<OpenZoeWithContextDetail>;
      if (custom.detail?.pageContext) {
        assistant.setPageContext(custom.detail.pageContext);
      }
      setShowGreeting(false);
      setOpen(true);
      if (custom.detail?.initialPrompt) {
        void assistant.sendMessage(custom.detail.initialPrompt, {
          pageContext: custom.detail.pageContext,
        });
      }
    };
    window.addEventListener(ZOE_OPEN_WITH_PAGE_CONTEXT_EVENT, handler);
    return () => window.removeEventListener(ZOE_OPEN_WITH_PAGE_CONTEXT_EVENT, handler);
  }, [assistant]);

  // Hidden if caller has no Zoe access or is already on the dedicated /me/zoe page
  if (hasAccess !== true || location.pathname === '/me/zoe') {
    return null;
  }

  const handleOpenLauncher = () => {
    setShowGreeting(false);
    setOpen(true);
  };

  return (
    <>
      {!open && (
        <div className="fixed bottom-4 right-4 z-40 flex max-w-[calc(100vw-2rem)] items-end gap-2.5 sm:bottom-6 sm:right-6">
          {showGreeting && (
            <div
              role="status"
              aria-live="polite"
              data-testid="zoe-greeting-bubble"
              onClick={handleOpenLauncher}
              className={cn(
                'relative max-w-[236px] cursor-pointer rounded-2xl rounded-br-sm border border-border bg-card px-3.5 py-2.5 pr-11 text-xs leading-snug text-card-foreground shadow-lg transition-all duration-500 animate-in fade-in slide-in-from-bottom-2 sm:max-w-[264px]',
                fadingGreeting ? 'translate-y-1 opacity-0' : 'opacity-100',
              )}
            >
              <button
                type="button"
                aria-label="Dismiss greeting"
                data-testid="zoe-greeting-dismiss"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowGreeting(false);
                }}
                className="absolute right-0.5 top-0.5 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <p className="font-semibold text-primary">Zoe</p>
              <p className="mt-0.5 text-xs text-foreground">{greetingText}</p>
              <span
                aria-hidden="true"
                className="absolute -bottom-1.5 right-3 h-3 w-3 rotate-45 border-b border-r border-border bg-card"
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleOpenLauncher}
            data-testid="zoe-floating-button"
            aria-label="Ask Zoe"
            className="group relative inline-flex min-h-[48px] shrink-0 items-center gap-2.5 rounded-full border border-primary/30 bg-primary py-1.5 pl-1.5 pr-4 text-xs font-semibold text-primary-foreground shadow-lg transition-transform hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
          >
            <span className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border-2 border-primary-foreground/80 bg-card shadow-sm">
              <img
                src={zoeAvatar}
                alt="Zoe"
                data-testid="zoe-launcher-avatar"
                className="h-full w-full object-cover"
              />
              <span
                aria-hidden="true"
                className="absolute bottom-0 right-0 h-2.5 w-2.5 rounded-full border border-card bg-emerald-500"
              />
            </span>
            <span>Ask Zoe</span>
          </button>
        </div>
      )}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          data-testid="zoe-floating-sheet"
          className="flex h-[100dvh] w-full max-w-full flex-col p-0 sm:max-w-lg"
        >
          <SheetTitle className="sr-only">Ask Zoe — My Space Staff Assistant</SheetTitle>
          <div className="flex-1 min-h-0">
            <ZoeChatSurface
              compact
              messages={assistant.messages}
              conversations={assistant.conversations}
              activeConversationId={assistant.activeConversationId}
              roles={roles}
              generatedBy={generatedBy}
              notes={assistant.notes}
              glossaryEntries={assistant.glossaryEntries}
              knowledgeEntries={assistant.knowledgeEntries}
              personalisedStarters={assistant.personalisedStarters}
              projects={assistant.projects}
              activeProjectId={assistant.activeProjectId}
              taughtUpdates={assistant.taughtUpdates}
              pushPrefs={assistant.pushPrefs}
              pageContext={assistant.pageContext}
              memoryEnabled={assistant.memoryEnabled}
              temporaryChat={assistant.temporaryChat}
              memorySuggestion={assistant.memorySuggestion}
              isLoading={assistant.isLoading}
              isHistoryLoading={assistant.isHistoryLoading}
              streamingText={assistant.streamingText}
              statusLine={assistant.statusLine}
              researchMode={assistant.researchMode}
              researchPlanSteps={assistant.researchPlanSteps}
              errorMessage={assistant.errorMessage}
              remainingQuestionsToday={assistant.remainingQuestionsToday}
              onToggleResearchMode={assistant.setResearchMode}
              onToggleMemoryEnabled={assistant.setMemoryEnabled}
              onToggleTemporaryChat={assistant.setTemporaryChat}
              onSelectProject={assistant.setActiveProjectId}
              onSaveProject={assistant.saveProject}
              onDeleteProject={assistant.deleteProject}
              onUpdatePushPrefs={assistant.updatePushPrefs}
              onAcceptMemorySuggestion={assistant.acceptMemorySuggestion}
              onDismissMemorySuggestion={assistant.dismissMemorySuggestion}
              onSendMessage={assistant.sendMessage}
              onStopGenerating={assistant.stopGenerating}
              onRegenerate={assistant.regenerateLastAnswer}
              onSelectConversation={assistant.selectConversation}
              onStartNewChat={assistant.startNewChat}
              onRenameConversation={assistant.renameConversation}
              onDeleteConversation={assistant.deleteConversation}
              onRetry={assistant.retryLastMessage}
              onFeedback={assistant.submitFeedback}
              onClearHistory={assistant.clearHistory}
              onAddNote={assistant.addNote}
              onUpdateNote={assistant.updateNote}
              onDeleteNote={assistant.deleteNote}
              onSaveGlossaryEntry={assistant.saveGlossaryEntry}
              onSaveKnowledgeEntry={assistant.saveKnowledgeEntry}
              headerSlot={
                <Link
                  to="/me/zoe"
                  onClick={() => setOpen(false)}
                  className="inline-flex min-h-[44px] w-full items-center justify-between gap-2 rounded-lg px-1 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>Full view</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              }
            />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
};

export default ZoeFloatingLauncher;
