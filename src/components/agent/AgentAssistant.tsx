import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Bot, Check, MessageCircle, Loader2, MapPin, MoreVertical, RotateCcw, Send, LifeBuoy } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/UserAvatar';
import { useProfile } from '@/hooks/useProfile';
import { useAssistantAccess } from '@/hooks/useAssistantAccess';
import { useAgentAssistant, type AssistantMessage } from '@/hooks/useAgentAssistant';
import { useIsMobile } from '@/hooks/use-mobile';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

const MAX_LEN = 500;
const SUGGESTIONS = [
  'How much did I collect today?',
  'What is remaining to collect today?',
  'How many tenants am I collecting for?',
  'Why is my collection low today?',
  'What is my wallet balance?',
  'Do I have any advances?',
];
const MUTED_OUTCOMES = new Set(['error', 'rate_limited', 'blocked']);

export function AgentAssistant() {
  const { enabled, isLoading } = useAssistantAccess();
  if (isLoading || !enabled) return null;
  return <AssistantCard />;
}

function AssistantCard() {
  const [open, setOpen] = useState(false);
  return (
    <>
      {createPortal(<Button
        type="button"
        size="icon"
        onClick={() => { hapticTap(); setOpen(true); }}
        aria-label="Chat with Welile Assistant"
        title="Chat with Welile Assistant"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          'fixed bottom-[max(var(--fab-bottom-stacked),10rem)] right-4 z-40 h-14 w-14 rounded-full border-2 border-background bg-primary text-primary-foreground shadow-lg shadow-primary/30 touch-manipulation fab-shrink-landscape active:scale-[0.96] transition-transform',
          open && 'hidden',
        )}
      >
        <MessageCircle className="h-6 w-6" aria-hidden="true" />
      </Button>, document.body)}
      <AssistantPanel open={open} onOpenChange={setOpen} />
    </>
  );
}

function AssistantPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const isMobile = useIsMobile();
  const { messages, isLoading, escalated, locationStatus, requestLocation, send, escalate, reset } = useAgentAssistant();
  const { profile } = useProfile();
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, isLoading]);

  const submit = (value: string) => {
    const v = value.trim();
    if (!v || isLoading) return;
    hapticTap();
    setText('');
    void send(v);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(text);
    }
  };

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={isMobile ? 'bottom' : 'right'}
        onOpenAutoFocus={(e) => { e.preventDefault(); inputRef.current?.focus(); }}
        className={cn(
          'flex flex-col p-0 gap-0',
          isMobile ? 'h-[100dvh] rounded-t-2xl' : 'inset-y-auto bottom-6 right-4 h-[min(640px,calc(100dvh-3rem))] w-[calc(100vw-2rem)] sm:max-w-md rounded-lg border border-border shadow-xl',
        )}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingTop: isMobile ? 'env(safe-area-inset-top)' : undefined }}
      >
        <SheetHeader className="flex-row items-center gap-3 space-y-0 border-b border-border/60 px-4 py-3 pr-12 text-left">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot className="h-5 w-5" />
          </span>
          <div className="flex-1 min-w-0">
            <SheetTitle className="text-base">Welile Assistant</SheetTitle>
            <SheetDescription className="text-xs">Answers about your own work.</SheetDescription>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-11 w-11" aria-label="Assistant options">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => { hapticTap(); reset(); setText(''); }}>
                <RotateCcw className="mr-2 h-4 w-4" /> New chat
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={messages.length === 0 || escalated || isLoading}
                onClick={() => { hapticTap(); void escalate(); }}
              >
                <LifeBuoy className="mr-2 h-4 w-4" /> Talk to support
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3" aria-live="polite" aria-relevant="additions">
          {messages.length === 0 && (
            <div className="space-y-4">
              <div className="rounded-2xl bg-muted/50 p-4 text-sm text-foreground">
                Hello. I can tell you about your collections, tenants, wallet and advances. Pick a question or type your own.
              </div>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <Chip key={s} label={s} disabled={isLoading} onClick={() => submit(s)} />
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              isLatest={m.id === lastAssistantId}
              disabled={isLoading}
              escalated={escalated}
              userAvatarUrl={profile?.avatar_url ?? null}
              userFullName={profile?.full_name ?? undefined}
              onQuickReply={submit}
              onEscalate={() => { hapticTap(); void escalate(); }}
            />
          ))}

          {isLoading && (
            <div className="flex justify-start" aria-label="Assistant is typing">
              <div className="flex items-center gap-1 rounded-2xl bg-muted px-4 py-3">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce" />
                <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:150ms]" />
                <span className="h-2 w-2 rounded-full bg-muted-foreground/60 animate-bounce [animation-delay:300ms]" />
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>

        <div className="border-t border-border/60 px-4 pt-3 pb-3 space-y-2">
          <LocationRow status={locationStatus} onRequest={() => { hapticTap(); requestLocation(); }} />
          <div className="flex items-end gap-2">
            <div className="relative flex-1">
              <Textarea
                ref={inputRef}
                value={text}
                maxLength={MAX_LEN}
                rows={1}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Ask a question"
                aria-label="Message the assistant"
                className="min-h-[44px] max-h-32 resize-none rounded-xl text-base"
              />
              {text.length >= MAX_LEN - 50 && (
                <span className="absolute bottom-1 right-2 text-[10px] text-muted-foreground">
                  {text.length}/{MAX_LEN}
                </span>
              )}
            </div>
            <Button
              type="button"
              size="icon"
              className="h-11 w-11 shrink-0 rounded-xl"
              disabled={!text.trim() || isLoading}
              onClick={() => submit(text)}
              aria-label="Send"
            >
              {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Chip({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="min-h-[44px] rounded-full border border-border/60 bg-card px-4 py-2 text-left text-sm text-foreground active:scale-[0.97] transition-all disabled:opacity-50 touch-manipulation"
    >
      {label}
    </button>
  );
}

function AssistantAvatar() {
  return (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"
    >
      <Bot className="h-4 w-4" />
    </span>
  );
}

function MessageBubble({
  message, isLatest, disabled, escalated, userAvatarUrl, userFullName, onQuickReply, onEscalate,
}: {
  message: AssistantMessage;
  isLatest: boolean;
  disabled: boolean;
  escalated: boolean;
  userAvatarUrl?: string | null;
  userFullName?: string;
  onQuickReply: (t: string) => void;
  onEscalate: () => void;
}) {
  if (message.role === 'user') {
    return (
      <div className="flex items-end justify-end gap-2">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {message.content}
        </div>
        <UserAvatar avatarUrl={userAvatarUrl ?? null} fullName={userFullName} size="sm" />
      </div>
    );
  }
  const muted = message.outcome ? MUTED_OUTCOMES.has(message.outcome) : false;
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex items-end justify-start gap-2">
        <AssistantAvatar />
        <div
          className={cn(
            'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md px-4 py-2.5 text-sm',
            muted ? 'bg-muted/50 text-muted-foreground border border-border/60' : 'bg-muted text-foreground',
          )}
        >
          {message.content}
        </div>
      </div>
      {isLatest && message.quickReplies && message.quickReplies.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {message.quickReplies.map((q) => (
            <Chip key={q} label={q} disabled={disabled} onClick={() => onQuickReply(q)} />
          ))}
        </div>
      )}
      {message.escalationOffered && (
        escalated ? (
          <span className="inline-flex min-h-[44px] items-center gap-2 rounded-full bg-muted px-4 text-sm text-muted-foreground">
            <Check className="h-4 w-4" /> Sent to support
          </span>
        ) : (
          <Button variant="outline" className="min-h-[44px] rounded-full" disabled={disabled} onClick={onEscalate}>
            <LifeBuoy className="mr-2 h-4 w-4" /> Send to support
          </Button>
        )
      )}
    </div>
  );
}

function LocationRow({ status, onRequest }: { status: string; onRequest: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <MapPin className="h-3.5 w-3.5 shrink-0" />
      <p className="flex-1 leading-snug">
        Share my location (optional). Lets support see roughly where you were when you asked for help. Only shared if you allow it in your browser.
      </p>
      {status === 'idle' && (
        <Button variant="outline" size="sm" className="min-h-[44px] shrink-0" onClick={onRequest}>Share</Button>
      )}
      {status === 'requesting' && <Loader2 className="h-4 w-4 animate-spin shrink-0" aria-label="Requesting location" />}
      {status === 'granted' && (
        <span className="inline-flex items-center gap-1 shrink-0 text-foreground"><Check className="h-4 w-4" /> Location shared</span>
      )}
      {(status === 'denied' || status === 'unavailable') && <span className="shrink-0">Location not shared</span>}
    </div>
  );
}
