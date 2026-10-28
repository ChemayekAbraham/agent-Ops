import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, ShieldAlert } from 'lucide-react';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { useAuth } from '@/hooks/useAuth';
import { ZoeChatSurface } from '@/components/zoe/ZoeChatSurface';
import { ZoeWeeklyLookAtCard } from '@/components/zoe/ZoeWeeklyLookAtCard';
import { useZoeAccess, useZoeAssistant } from '@/components/zoe/useZoeAssistant';

const ZoePage: React.FC = () => {
  const { user, roles } = useAuth();
  const { data: hasAccess, isLoading: accessLoading } = useZoeAccess();
  const assistant = useZoeAssistant(hasAccess === true);
  const generatedBy =
    (typeof user?.user_metadata?.full_name === 'string' && user.user_metadata.full_name.trim()) ||
    user?.email ||
    null;

  return (
    <PersonalLayout title="Ask Zoe">
      {accessLoading ? (
        <div
          data-testid="zoe-page-loading"
          className="flex min-h-[240px] items-center justify-center gap-2 rounded-xl border border-border bg-card p-6 text-xs text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          <span>Verifying My Space assistant access...</span>
        </div>
      ) : hasAccess !== true ? (
        <div
          data-testid="zoe-access-denied"
          className="space-y-3 rounded-xl border border-border bg-card p-5 text-card-foreground"
        >
          <div className="flex items-center gap-2.5 text-sm font-semibold text-foreground">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            <span>Zoe is available only to enabled Welile staff roles</span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Your account does not currently have Zoe staff assistant access enabled in My Space.
          </p>
          <Link
            to="/me"
            className="inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to My Space</span>
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          <ZoeWeeklyLookAtCard roles={roles} defaultExpanded={false} />
          <ZoeChatSurface
            messages={assistant.messages}
            conversations={assistant.conversations}
            activeConversationId={assistant.activeConversationId}
            roles={roles}
            generatedBy={generatedBy}
            morningBrief={assistant.morningBrief}
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
          />
        </div>
      )}
    </PersonalLayout>
  );
};

export default ZoePage;
