import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { ArrowLeft, ArrowUp, Check, Copy, History, LifeBuoy, X } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Conversation, ConversationContent, ConversationScrollButton } from '@/components/ai-elements/conversation';
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message';
import { useAgentAssistant } from '@/hooks/useAgentAssistant';
import { useAuth } from '@/hooks/useAuth';
import { useIsMobile } from '@/hooks/use-mobile';
import { supabase } from '@/integrations/supabase/client';
import { toAuthGatedPath } from '@/lib/nexaSalesEngine';
import { type AiRole } from './roleLanding';
import { ASSISTANT_NAME, HELP_URL, VISIBLE_CHIPS, WHATSAPP_URL, orderedChips } from './assistantConfig';

const INITIAL = ASSISTANT_NAME.charAt(0).toUpperCase();
function Avatar({ size = 'h-7 w-7' }: { size?: string }) {
  return <span className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground`} aria-hidden="true">{INITIAL}</span>;
}

export interface AssistantChatSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialRole?: AiRole;
  signupSource?: string | null;
  referralCode?: string | null;
}

interface PastMessage { id: string; conversation_id: string; role: 'user' | 'assistant'; content: string; created_at: string }

function HistoryList({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<PastMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    void (supabase.rpc as unknown as (fn: string, args: object) => Promise<{ data: { messages?: PastMessage[] } | null; error: unknown }>)('assistant_my_messages', { p_limit: 50 })
      .then(({ data, error }) => { if (!live) return; setFailed(!!error); setRows(error ? [] : data?.messages ?? []); });
    return () => { live = false; };
  }, []);
  const groups: { id: string; last: PastMessage }[] = [];
  for (const m of rows ?? []) if (!groups.some(g => g.id === m.conversation_id)) groups.push({ id: m.conversation_id, last: m });
  return <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
    {rows === null ? <p className="py-8 text-center text-sm text-muted-foreground">Loading…</p>
      : groups.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">{failed ? "Couldn't load your chats right now." : 'No past chats yet.'}</p>
      : <ul className="divide-y divide-border">{groups.map(g => <li key={g.id}>
        <button type="button" onClick={onBack} className="flex w-full flex-col items-start gap-0.5 py-3 text-left">
          <span className="w-full truncate text-sm text-foreground">{g.last.content}</span>
          <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(g.last.created_at), { addSuffix: true })}</span>
        </button>
      </li>)}</ul>}
  </div>;
}

export function AssistantChatSurface({ open, onOpenChange }: AssistantChatSurfaceProps) {
  const { user, role } = useAuth() as ReturnType<typeof useAuth> & { role?: string | null };
  const isMobile = useIsMobile();
  const { messages, isLoading, send, stop, escalate, escalated } = useAgentAssistant();
  const [text, setText] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [rotation, setRotation] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { pathname } = useLocation();
  const agentFirst = role === 'agent' || pathname.startsWith('/dashboard/agent');
  const chips = orderedChips(agentFirst);
  const visibleChips = Array.from({ length: Math.min(VISIBLE_CHIPS, chips.length) }, (_, i) => chips[(rotation + i) % chips.length]);
  const firstName = String(user?.user_metadata?.full_name ?? '').trim().split(/\s+/)[0] || 'there';

  useEffect(() => {
    if (!open || isLoading || showHistory) return;
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [open, isLoading, showHistory]);

  const resize = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 104)}px`; };
  const submit = (value: string) => {
    if (!value.trim() || isLoading) return;
    setText(''); if (inputRef.current) inputRef.current.style.height = 'auto';
    setRotation(r => (r + 1) % chips.length);
    void send(value);
  };
  const actionHref = (href?: string) => {
    if (!href) return undefined;
    try {
      const url = new URL(href, window.location.origin);
      if (!['https:', 'http:', 'mailto:', 'tel:'].includes(url.protocol)) return undefined;
      if (!user && (url.origin === window.location.origin || url.hostname === 'welileapp.com' || url.hostname === 'www.welileapp.com')) return toAuthGatedPath(url.pathname + url.search + url.hash);
      return href;
    } catch { return undefined; }
  };

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side={isMobile ? 'bottom' : 'right'} onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }} className={`assistant-chat flex flex-col gap-0 overflow-hidden bg-background p-0 [&>button:last-child]:hidden ${isMobile ? 'h-[100dvh] rounded-none pt-safe pb-safe' : 'inset-y-auto bottom-6 right-4 h-[min(720px,calc(100dvh-3rem))] w-[calc(100vw-2rem)] sm:max-w-[420px] rounded-2xl border border-border'}`}>
      <SheetHeader className="flex flex-row items-center gap-2 space-y-0 border-b border-border px-3 py-2.5 text-left [&>button:first-child]:hidden">
        {showHistory ? <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Back to chat" onClick={() => setShowHistory(false)}><ArrowLeft /></Button> : <Avatar size="h-8 w-8" />}
        <div className="min-w-0 flex-1 leading-tight">
          <SheetTitle className="text-[15px] font-semibold">{showHistory ? 'Past chats' : ASSISTANT_NAME}</SheetTitle>
          {!showHistory && <p className="flex items-center gap-1 text-xs text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-primary" />Online</p>}
          <SheetDescription className="sr-only">Chat with {ASSISTANT_NAME}</SheetDescription>
        </div>
        {!showHistory && user && <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Past chats" title="Past chats" onClick={() => setShowHistory(true)}><History /></Button>}
        <Button variant="ghost" size="icon-sm" className="rounded-full" aria-label="Close" onClick={() => onOpenChange(false)}><X /></Button>
      </SheetHeader>

      {showHistory ? <HistoryList onBack={() => setShowHistory(false)} /> : <>
        <Conversation initial={false} resize="instant" className="min-h-0 flex-1" aria-live="polite">
          <ConversationContent className={`gap-4 px-4 py-4 ${messages.length === 0 ? 'min-h-full justify-end' : ''}`}>
            {messages.length === 0 && <div className="flex items-start gap-2.5"><Avatar /><p className="rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-[15px] leading-relaxed text-foreground">Hi {firstName} 👋 I'm {ASSISTANT_NAME}. Ask me about your collections, tenants, team or how Welile works.</p></div>}
            {messages.map((message, index) => <Message key={message.id} from={message.role} className="max-w-full">
              {message.role === 'user'
                ? <MessageContent className="max-w-[82%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2.5 text-[15px] leading-relaxed text-primary-foreground">{message.content}</MessageContent>
                : <div className="flex w-full items-start gap-2.5"><Avatar /><div className="min-w-0 max-w-[85%]">
                  <div className="rounded-2xl rounded-tl-sm bg-muted px-3.5 py-2.5 text-foreground">
                    <MessageResponse className="break-words text-[15px] leading-relaxed [&_a]:underline [&_a]:underline-offset-2" components={{ a: ({ href, children }) => <a href={actionHref(href)}>{children}</a> }}>{message.content}</MessageResponse>
                  </div>
                  <div className="mt-1 flex items-center gap-1 text-muted-foreground">
                    <Button variant="ghost" size="icon-sm" aria-label="Copy reply" onClick={async () => { try { await navigator.clipboard.writeText(message.content); setCopied(message.id); } catch { setCopied(null); } }}>{copied === message.id ? <Check /> : <Copy />}</Button>
                    {message.escalationOffered && <Button variant="ghost" size="sm" disabled={isLoading || escalated} onClick={() => void escalate()}><LifeBuoy />{escalated ? 'Sent to support' : 'Send to support'}</Button>}
                  </div>
                  {index === messages.length - 1 && message.quickReplies && <div className="mt-1 flex flex-wrap gap-2">{message.quickReplies.map(reply => <Button key={reply} variant="outline" size="sm" className="h-auto min-h-9 whitespace-normal rounded-full" disabled={isLoading} onClick={() => submit(reply)}>{reply}</Button>)}</div>}
                </div></div>}
            </Message>)}
            {isLoading && <div className="flex items-center gap-2.5" aria-label={`${ASSISTANT_NAME} is typing`}><Avatar /><span className="flex gap-1 rounded-2xl bg-muted px-3.5 py-3">{[0, 150, 300].map(d => <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground motion-reduce:animate-none" style={{ animationDelay: `${d}ms` }} />)}</span></div>}
          </ConversationContent>
          {messages.length > 0 && <ConversationScrollButton aria-label="Scroll to latest" />}
        </Conversation>

        <div className="shrink-0 border-t border-border bg-background px-3 pb-2 pt-2">
          {!isLoading && <div className="-mx-3 mb-2 flex gap-2 overflow-x-auto px-3 pb-1 [scrollbar-width:none]" aria-label="Suggestions">
            {visibleChips.map(chip => <button key={chip} type="button" onClick={() => submit(chip)} className="shrink-0 whitespace-nowrap rounded-full border border-border bg-card px-3 py-1.5 text-sm text-foreground transition-colors hover:bg-muted">{chip}</button>)}
          </div>}
          <form onSubmit={e => { e.preventDefault(); submit(text); }} className="flex items-end gap-2 rounded-3xl border border-border bg-card px-3 py-1.5">
            <textarea ref={inputRef} value={text} rows={1} maxLength={500} disabled={isLoading} aria-label={`Message ${ASSISTANT_NAME}`} placeholder={`Message ${ASSISTANT_NAME}…`}
              onChange={e => { setText(e.target.value); resize(e.target); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(text); } }}
              className="max-h-[104px] min-h-9 flex-1 resize-none bg-transparent py-1.5 text-base leading-6 text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 md:text-[15px]" />
            {isLoading
              ? <Button type="button" size="icon" className="h-9 w-9 shrink-0 rounded-full" aria-label="Stop response" onClick={stop}><span className="h-3 w-3 rounded-sm bg-primary-foreground" /></Button>
              : <Button type="submit" size="icon" className="h-9 w-9 shrink-0 rounded-full" aria-label="Send message" disabled={!text.trim()}><ArrowUp /></Button>}
          </form>
          <div className="mt-1.5 flex justify-center gap-3 text-xs text-muted-foreground">
            <a href={WHATSAPP_URL} target="_blank" rel="noopener" className="hover:text-foreground hover:underline">Talk to a person</a>
            <span aria-hidden="true">·</span>
            <a href={HELP_URL} target="_blank" rel="noopener" className="hover:text-foreground hover:underline">Help centre</a>
          </div>
        </div>
      </>}
    </SheetContent>
  </Sheet>;
}
