import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ExternalLink, MessageSquare } from 'lucide-react';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/hooks/useAuth';
import { ZoeChatSurface } from './ZoeChatSurface';
import { useZoeAccess, useZoeAssistant } from './useZoeAssistant';

/**
 * Small floating "Ask Zoe" launcher displayed on My Space pages when
 * `staff_assistant_has_access()` is true. Opens the shared `ZoeChatSurface`
 * in a mobile-first sheet, with a one-tap link to the full `/me/zoe` page.
 */
export const ZoeFloatingLauncher: React.FC = () => {
  const location = useLocation();
  const { user, roles } = useAuth();
  const { data: hasAccess } = useZoeAccess();
  const [open, setOpen] = useState(false);
  const generatedBy =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()) ||
    user?.email ||
    null;

  // Only load conversation history when the floating sheet is actually opened
  const assistant = useZoeAssistant(open && hasAccess === true);

  // Hidden if caller has no Zoe access or is already on the dedicated /me/zoe page
  if (hasAccess !== true || location.pathname === '/me/zoe') {
    return null;
  }

  return (
    <>
      <div className="fixed bottom-4 right-4 z-40 sm:bottom-6 sm:right-6">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="zoe-floating-button"
          aria-label="Ask Zoe"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-full border border-primary/30 bg-primary px-4 py-2.5 text-xs font-semibold text-primary-foreground shadow-lg transition-transform hover:bg-primary/90 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
        >
          <MessageSquare className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Ask Zoe</span>
        </button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="flex w-full max-w-full flex-col p-2 sm:max-w-lg sm:p-4"
        >
          <SheetTitle className="sr-only">Ask Zoe — My Space Staff Assistant</SheetTitle>
          <div className="mt-6 flex-1 min-h-0">
            <ZoeChatSurface
              compact
              messages={assistant.messages}
              conversations={assistant.conversations}
              activeConversationId={assistant.activeConversationId}
              roles={roles}
              generatedBy={generatedBy}
              notes={assistant.notes}
              glossaryEntries={assistant.glossaryEntries}
              isLoading={assistant.isLoading}
              isHistoryLoading={assistant.isHistoryLoading}
              streamingText={assistant.streamingText}
              statusLine={assistant.statusLine}
              errorMessage={assistant.errorMessage}
              remainingQuestionsToday={assistant.remainingQuestionsToday}
              onSendMessage={assistant.sendMessage}
              onStopGenerating={assistant.stopGenerating}
              onRegenerate={assistant.regenerateLastAnswer}
              onSelectConversation={assistant.selectConversation}
              onStartNewChat={assistant.startNewChat}
              onRenameConversation={assistant.renameConversation}
              onRetry={assistant.retryLastMessage}
              onFeedback={assistant.submitFeedback}
              onClearHistory={assistant.clearHistory}
              onAddNote={assistant.addNote}
              onDeleteNote={assistant.deleteNote}
              onSaveGlossaryEntry={assistant.saveGlossaryEntry}
              headerSlot={
                <Link
                  to="/me/zoe"
                  onClick={() => setOpen(false)}
                  className="inline-flex min-h-[44px] items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>Full view</span>
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
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
